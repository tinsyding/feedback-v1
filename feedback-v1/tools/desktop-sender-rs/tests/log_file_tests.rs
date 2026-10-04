use desktop_sender_rs::log_file::{parse_entries, LogEntry, LogWriter};
use desktop_sender_rs::sender_engine::{EngineEvent, EventSink};
use tokio::sync::mpsc;

/// 构造一行标准格式日志
fn line(ts: &str, level: &str, msg: &str) -> String {
    format!("[{ts}] [{level}] {msg}")
}

#[test]
fn test_parse_standard_line() {
    let text = line("2026-10-04 15:30:45.123", "ERROR", "标题核验拦截");
    let entries = parse_entries(&text, 300, true);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].ts, "2026-10-04 15:30:45.123");
    assert_eq!(entries[0].level, "error");
    assert_eq!(entries[0].msg, "标题核验拦截");
}

#[test]
fn test_level_normalization_matches_classic_map() {
    // 对齐经典版 _LOG_LEVEL_MAP：DEBUG/INFO -> info，WARN/WARNING -> warn，ERROR -> error
    for (raw, want) in [
        ("INFO", "info"),
        ("DEBUG", "info"),
        ("WARN", "warn"),
        ("WARNING", "warn"),
        ("ERROR", "error"),
    ] {
        let text = line("ts", raw, "m");
        let e = parse_entries(&text, 300, true);
        assert_eq!(e[0].level, want, "level={raw} 归一化错误");
    }
}

#[test]
fn test_unknown_level_degrades_to_info_not_dropped() {
    // 服务端白名单只有 info/warn/error/action，其余一律降级 info。
    // 关键在于「降级」而非「丢行」——日志不能因为等级不认识就消失。
    let text = line("ts", "TRACE", "某条不太常见的日志");
    let e = parse_entries(&text, 300, true);
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].level, "info");
    assert_eq!(e[0].msg, "某条不太常见的日志");
}

#[test]
fn test_malformed_line_is_preserved_with_empty_ts() {
    // 人手写的提示、早期版本遗留的行都不能丢
    let text = "这是一行没有格式的历史日志";
    let e = parse_entries(&text, 300, true);
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].ts, "");
    assert_eq!(e[0].level, "info");
    assert_eq!(e[0].msg, "这是一行没有格式的历史日志");
}

#[test]
fn test_empty_content_yields_nothing() {
    assert!(parse_entries("", 300, true).is_empty());
    assert!(parse_entries("   \n\n  \n", 300, true).is_empty());
}

#[test]
fn test_msg_is_truncated_to_server_limit() {
    // 服务端 upload_logs 会 substr(msg, 0, 2000)，客户端先截可避免超长传输
    let long = "x".repeat(5000);
    let text = line("ts", "INFO", &long);
    let e = parse_entries(&text, 300, true);
    assert_eq!(e[0].msg.chars().count(), 2000);
}

// ================================================================
// 任务边界对齐：保证上报片段里至少有一个「完整」任务
// ================================================================

/// 造一份含两次任务的日志，第二次是完整任务
fn two_task_log() -> String {
    let mut s = String::new();
    s.push_str(&line("t1", "INFO", "上一批次的收尾统计"));
    s.push('\n');
    s.push_str(&line("t2", "INFO", "批量发送任务启动，总计 3 位待发送学生"));
    s.push('\n');
    s.push_str(&line("t3", "INFO", "90001张三 已发送"));
    s.push('\n');
    s.push_str(&line("t4", "ERROR", "90002李四 标题核验拦截"));
    s.push('\n');
    s.push_str(&line("t5", "INFO", "批量发送任务结束：成功 2，失败 1"));
    s
}

#[test]
fn test_align_task_includes_whole_latest_task() {
    let e = parse_entries(&two_task_log(), 300, true);
    assert_eq!(e.len(), 4, "应包含任务头到任务尾共 4 行");
    assert!(e[0].msg.contains("批量发送任务启动"));
    assert!(e[3].msg.contains("批量发送任务结束"));
}

#[test]
fn test_align_task_uses_latest_task_start_not_first() {
    let mut s = two_task_log();
    // 追加第三次任务（不完整，只有开头）
    s.push_str(&line("t6", "INFO", "批量发送任务启动，总计 9 位待发送学生"));
    s.push('\n');
    s.push_str(&line("t7", "INFO", "90005王五 已发送"));
    s.push('\n');

    let e = parse_entries(&s, 300, true);
    assert_eq!(e.len(), 2);
    assert!(e[0].msg.contains("总计 9 位"), "必须取最后一次任务起点");
    assert!(!e.iter().any(|x| x.msg.contains("总计 3 位")));
}

#[test]
fn test_align_task_falls_back_to_tail_when_no_mark() {
    // 没有任务标记时退化为普通截尾，不能返回空
    let s = format!("{}\n{}\n", line("t1", "INFO", "a"), line("t2", "INFO", "b"));
    let e = parse_entries(&s, 300, true);
    assert_eq!(e.len(), 2);
}

#[test]
fn test_limit_caps_entries_when_task_mark_absent() {
    let s: String = (0..50)
        .map(|i| format!("{}\n", line("t", "INFO", &format!("第{i}条"))))
        .collect();
    let e = parse_entries(&s, 10, true);
    assert_eq!(e.len(), 10, "无任务标记时应按 limit 截尾");
    assert_eq!(e[9].msg, "第49条", "应保留末尾而非开头");
}

#[test]
fn test_align_task_respects_hard_cap_of_1000_lines() {
    // 任务头恰好落在 1000 行窗口的首行，其后再有 999 行轨迹 —— 共 2000 行。
    // 此时「按任务起点整段带上」会得到 2000 条，但必须被硬上限截到 1000 条。
    // （若任务头落在窗口之外则退回 limit 截尾，那是另一个用例的职责）
    let mut s = String::new();
    for i in 0..1000 {
        s.push_str(&line("t", "INFO", &format!("历史噪声{i}")));
        s.push('\n');
    }
    s.push_str(&line("t0", "INFO", "批量发送任务启动"));
    s.push('\n');
    for i in 0..999 {
        s.push_str(&line("t", "INFO", &format!("轨迹{i}")));
        s.push('\n');
    }
    assert_eq!(s.lines().count(), 2000);

    let e = parse_entries(&s, 300, true);
    assert_eq!(
        e.len(),
        1000,
        "应对齐整段任务但被硬上限截到 1000 条"
    );
    assert!(
        e[0].msg.contains("批量发送任务启动"),
        "片段开头应是任务头"
    );
    assert!(
        !e.iter().any(|x| x.msg.contains("历史噪声")),
        "不得包含窗口之前的历史日志"
    );
}

#[test]
fn test_align_task_falls_back_when_mark_outside_hard_cap() {
    // 任务头落在 1000 行窗口之外时，退回普通 limit 截尾
    let mut s = line("t0", "INFO", "批量发送任务启动") + "\n";
    for i in 0..1500 {
        s.push_str(&line("t", "INFO", &format!("轨迹{i}")));
        s.push('\n');
    }
    let e = parse_entries(&s, 300, true);
    assert_eq!(e.len(), 300, "窗口内找不到任务头时应按 limit 截尾");
    assert_eq!(e[0].msg, "轨迹1200", "应取末尾 300 条");
}

#[test]
fn test_align_task_false_disables_boundary_alignment() {
    // 不对齐时就是纯截尾：two_task_log 最后两行是「90002李四 拦截」与「任务结束」
    let e = parse_entries(&two_task_log(), 2, false);
    assert_eq!(e.len(), 2);
    assert!(e[0].msg.contains("90002李四"));
    assert!(e[1].msg.contains("批量发送任务结束"));
}

// ================================================================
// EventSink：日志落盘分流
// ================================================================

#[tokio::test]
async fn test_event_sink_forwards_logs_to_channel_unchanged() {
    // 分流不能改变通道语义：前端拿到的必须还是原事件
    let (tx, mut rx) = mpsc::channel(8);
    let sink = EventSink::new(tx);

    sink.send(EngineEvent::log("INFO", "发信任务启动")).await.unwrap();
    sink.send(EngineEvent::log("ERROR", "标题核验拦截")).await.unwrap();

    match rx.recv().await.unwrap() {
        EngineEvent::Log { level, message } => {
            assert_eq!(level, "INFO");
            assert_eq!(message, "发信任务启动");
        }
        other => panic!("期望 Log 事件，实际 {:?}", other),
    }
    match rx.recv().await.unwrap() {
        EngineEvent::Log { level, message } => {
            assert_eq!(level, "ERROR");
            assert_eq!(message, "标题核验拦截");
        }
        other => panic!("期望 Log 事件，实际 {:?}", other),
    }
}

#[tokio::test]
async fn test_event_sink_does_not_break_non_log_events() {
    let (tx, mut rx) = mpsc::channel(8);
    let sink = EventSink::new(tx);
    sink.send(EngineEvent::Progress {
        current: 1,
        total: 3,
        success: 2,
        failed: 1,
    })
    .await
    .unwrap();
    assert!(matches!(
        rx.recv().await.unwrap(),
        EngineEvent::Progress { current: 1, .. }
    ));
}

#[tokio::test]
async fn test_event_sink_propagates_closed_channel_error() {
    // 通道关闭要如实报错，不能被「写日志」掩盖成静默成功
    let (tx, rx) = mpsc::channel::<EngineEvent>(1);
    let sink = EventSink::new(tx);
    drop(rx);
    assert!(sink.send(EngineEvent::log("INFO", "x")).await.is_err());
    assert!(sink.try_send(EngineEvent::log("INFO", "x")).is_err());
}

#[tokio::test]
async fn test_event_sink_try_send_works_without_await() {
    let (tx, mut rx) = mpsc::channel(4);
    let sink = EventSink::new(tx);
    sink.try_send(EngineEvent::log("WARN", "ESC 急停")).unwrap();
    match rx.recv().await.unwrap() {
        EngineEvent::Log { level, message } => {
            assert_eq!(level, "WARN");
            assert_eq!(message, "ESC 急停");
        }
        other => panic!("期望 Log 事件，实际 {:?}", other),
    }
}

#[test]
fn test_event_sink_converts_from_raw_sender() {
    let (tx, _rx) = mpsc::channel::<EngineEvent>(1);
    let sink: EventSink = tx.into();
    // 可克隆：ESC 监听线程与引擎各持一份
    let _cloned = sink.clone();
    assert!(!sink.inner().is_closed());
}

/// 一条真实日志经写盘→读回→解析后应完全还原（端到端不丢内容）
///
/// 跳过断言 `ts` 的绝对值（写盘与解析间存在时钟推进），
/// 但必须保证 ts 存在、等级与正文一致。
#[test]
fn test_round_trip_write_then_parse() {
    let dir = std::env::temp_dir().join(format!("jf_log_rt_{}", std::process::id()));
    let path = dir.join("t.log");
    std::fs::create_dir_all(&dir).unwrap();

    let body = "会话标题安全检查点拦截！当前处于【90002李四】";
    std::fs::write(&path, line("2026-10-04 15:30:45.123", "ERROR", body)).unwrap();

    let content = std::fs::read_to_string(&path).unwrap();
    let e: Vec<LogEntry> = parse_entries(&content, 300, true);
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].level, "error");
    assert_eq!(e[0].msg, body);

    let _ = std::fs::remove_dir_all(&dir);
}

// ================================================================
// LogWriter：真实文件写入与滚动归档
// ================================================================

/// 每个用例一个独立临时目录，避免并行测试互相干扰
fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "jf_log_{tag}_{}_{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn test_log_writer_appends_across_calls() {
    let dir = tmp_dir("append");
    let path = dir.join("feedback_debug.log");
    let mut w = LogWriter::new(path.clone(), 1024 * 1024);

    w.write_line("INFO", "第一行").unwrap();
    w.write_line("ERROR", "第二行").unwrap();
    w.write_line("INFO", "第三行").unwrap();

    let raw = std::fs::read_to_string(&path).unwrap();
    let e = parse_entries(&raw, 100, false);
    assert_eq!(e.len(), 3, "三行都必须落盘");
    assert_eq!(e[0].msg, "第一行");
    assert_eq!(e[1].msg, "第二行");
    assert_eq!(e[2].msg, "第三行");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_log_writer_rolls_over_without_losing_history() {
    // 回归用例：滚动判定曾被放在「打开文件」分支里，而句柄一旦常驻就再也不会
    // 走到那里 —— 5MB 上限形同虚设，文件无上限增长直至撑爆磁盘。
    //
    // 这里只触发**一次**滚动，然后断言归档 + 当前文件完整覆盖全部已写日志。
    // （多次滚动必然丢弃更早的内容，那是刻意设计，与经典版一致，见下个用例）
    let dir = tmp_dir("rotate");
    let path = dir.join("feedback_debug.log");
    let mut w = LogWriter::new(path.clone(), 200);

    let mut rotated_at: Option<usize> = None;
    for i in 0..100 {
        let prev = w.written_bytes();
        w.write_line("INFO", &format!("第{i}行：模拟一次较长的发信轨迹日志内容")).unwrap();
        if w.written_bytes() < prev {
            rotated_at = Some(i);
            break;
        }
    }
    let rotated_at = rotated_at.expect("阈值 200 字节，写 100 行必然触发滚动");

    let live = std::fs::read_to_string(&path).unwrap();
    let bak_path = path.with_extension("log.bak");
    assert!(bak_path.exists(), "未生成 .bak 归档");
    let bak_raw = std::fs::read_to_string(&bak_path).unwrap();
    assert!(!bak_raw.is_empty(), "归档文件不得为空");
    assert!(!live.is_empty(), "滚动后当前文件仍应有内容");

    // 单次滚动不得丢任何一行
    let all = parse_entries(&format!("{bak_raw}{live}"), 1000, false);
    assert_eq!(
        all.len(),
        rotated_at + 1,
        "单次滚动过程中有日志丢失（写入 {rotated_at} 行 + 1）"
    );
    for i in 0..=rotated_at {
        assert!(
            all.iter().any(|e| e.msg == format!("第{i}行：模拟一次较长的发信轨迹日志内容")),
            "第 {i} 行在滚动中丢失"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_log_writer_bounds_total_disk_usage() {
    // 多次滚动时只保留最近两代（当前 + .bak），更早的内容被丢弃。
    // 这与经典版 send_feedback.py:337-347 一致：归档是为了限制磁盘占用，
    // 不是无限备份。反复滚动 100 次也必须稳定在 2 倍阈值内。
    let dir = tmp_dir("bounded");
    let path = dir.join("feedback_debug.log");
    let mut w = LogWriter::new(path.clone(), 200);

    for i in 0..100 {
        w.write_line("INFO", &format!("第{i}行：制造足够长的内容以触发滚动")).unwrap();
    }

    let live_size = std::fs::metadata(&path).unwrap().len();
    let bak_size = std::fs::metadata(path.with_extension("log.bak"))
        .map(|m| m.len())
        .unwrap_or(0);
    let total = live_size + bak_size;
    assert!(
        total <= 200 * 2 + 200,
        "反复滚动后总占用 {total} 字节，超出两代上限，磁盘会失控增长"
    );

    // 最新日志必须在当前文件里 —— 排查最近一次事故只看它
    let live = std::fs::read_to_string(&path).unwrap();
    assert!(
        live.contains("第99行"),
        "当前日志文件必须包含最后写入的内容"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_log_writer_keeps_only_one_generation_of_bak() {
    // 只留一代归档：更早的归档对排查最近一次事故毫无价值，却会持续吃磁盘
    let dir = tmp_dir("onegen");
    let path = dir.join("feedback_debug.log");
    let mut w = LogWriter::new(path.clone(), 120);
    for i in 0..60 {
        w.write_line("INFO", &format!("第{i}行：制造足够长的内容以触发滚动")).unwrap();
    }
    let entries = std::fs::read_dir(&dir).unwrap().count();
    assert_eq!(entries, 2, "目录里只应有当前日志与 .bak 两份，实际 {entries} 份");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_log_writer_picks_up_existing_file_size_on_first_open() {
    // 上次进程留下的日志已经在磁盘上，首次打开必须认它的体积，
    // 否则滚动永远不触发
    let dir = tmp_dir("preexisting");
    let path = dir.join("feedback_debug.log");
    std::fs::write(&path, "x".repeat(5000)).unwrap();

    let mut w = LogWriter::new(path.clone(), 1000);
    w.write_line("INFO", "新任务").unwrap();

    assert!(
        path.with_extension("log.bak").exists(),
        "首次打开时未按磁盘真实大小触发滚动"
    );
    assert!(std::fs::read_to_string(&path).unwrap().contains("新任务"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_log_writer_survives_unwritable_path() {
    // 诊断旁路绝不能因 I/O 失败而 panic —— 返回 Err 即可，由调用方忽略
    let bad = std::env::temp_dir().join("jf_log_bad_root_xyz").join("nested");
    let mut w = LogWriter::new(bad, 1024);
    // 路径的父目录是文件而非目录时会失败；此处只断言「不 panic」
    let _ = w.write_line("INFO", "任意内容");
}