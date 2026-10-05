use desktop_sender_rs::debug_shot::{
    data_dir, sanitize_filename, save_debug_shot_into, DebugShotError,
};
use desktop_sender_rs::log_file::timestamp_compact;
use image::{DynamicImage, GrayImage};
use std::path::PathBuf;

/// 每个用例独占一个临时目录，互不干扰，也不依赖进程级环境变量
fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "jf_shot_{tag}_{}_{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 造一张指定尺寸的「真实」截图（纯色即可，测试只关心尺寸与落盘）
fn shot(w: u32, h: u32) -> DynamicImage {
    DynamicImage::ImageLuma8(GrayImage::from_raw(w, h, vec![128; (w * h) as usize]).unwrap())
}

// ================================================================
// 归档主路径
// ================================================================

#[test]
fn test_saves_real_capture_with_traceable_filename() {
    let dir = tmp_dir("basic");
    let path = save_debug_shot_into(
        &dir,
        &shot(400, 52),
        "header",
        "mismatch",
        "90001",
        "张三妈妈",
    )
    .expect("真实尺寸截图应被归档");

    assert!(path.exists(), "归档文件未落盘");
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    // 文件名必须能溯源：时间戳 + 类别 + 判定标签 + 学号姓名
    assert!(name.contains("header"), "缺类别：{name}");
    assert!(name.contains("mismatch"), "缺判定标签：{name}");
    assert!(name.contains("90001"), "缺学号：{name}");
    assert!(name.ends_with(".png"), "扩展名错误：{name}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_creates_missing_output_directory() {
    let dir = tmp_dir("mkd").join("a").join("b").join("shots");
    assert!(!dir.exists());
    let path = save_debug_shot_into(&dir, &shot(200, 40), "header", "mismatch", "90001", "张三")
        .expect("输出目录不存在时应自动创建");
    assert!(path.exists(), "自动建目录后仍未落盘");
    let _ = std::fs::remove_dir_all(tmp_dir("mkd"));
}

#[test]
fn test_rejects_placeholder_images() {
    let dir = tmp_dir("placeholder");

    // 驱动未提供真实图像时退化成 1x1 占位图 —— 归档它只会污染截图目录。
    // 必须能区分「没截到图」与「写盘失败」：前者是驱动问题，后者是环境问题，
    // 混成一个 None 就都没法排查了。
    for (w, h) in [(1u32, 1u32), (40, 4), (8, 60)] {
        match save_debug_shot_into(&dir, &shot(w, h), "dropdown", "choice1", "90001", "张三") {
            Err(DebugShotError::NotCaptured { width, height }) => {
                assert_eq!((width, height), (w, h), "尺寸信息应如实回报");
            }
            other => panic!("{w}x{h} 应被判为未捕获到图，实际 {other:?}"),
        }
    }
    // 恰好卡在下限之上必须放行，否则守卫会误杀真实截图
    assert!(
        save_debug_shot_into(&dir, &shot(16, 8), "header", "mismatch", "90001", "张三").is_ok(),
        "恰好等于下限的真实截图被误杀"
    );

    // 被拒的占位图不得留下任何文件
    let leftovers = std::fs::read_dir(&dir).unwrap().count();
    assert_eq!(leftovers, 1, "占位图不应落盘，实际留下 {leftovers} 个文件");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_filename_escapes_illegal_characters() {
    let dir = tmp_dir("sanitize");
    // 姓名可能含 / \ : * ? " < > | 与空白 —— 任一都会让 Windows 写盘失败
    let path = save_debug_shot_into(
        &dir,
        &shot(200, 40),
        "header",
        "vlm_mismatch",
        "90/001",
        "张 三|妈妈",
    )
    .expect("含非法字符也应成功归档");

    let name = path.file_name().unwrap().to_string_lossy().to_string();
    for bad in ["/", "\\", ":", "*", "?", "\"", "<", ">", "|"] {
        assert!(!name.contains(bad), "文件名残留非法字符 {bad:?}：{name}");
    }
    assert!(!name.contains(' '), "文件名残留空格：{name}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_multiple_shots_accumulate_with_distinct_names() {
    let dir = tmp_dir("accumulate");
    // 不同学生 / 不同判定标签必须落到不同文件，后一次不得覆盖前一次
    let a = save_debug_shot_into(&dir, &shot(300, 40), "header", "mismatch", "90001", "张三").unwrap();
    let b = save_debug_shot_into(&dir, &shot(300, 40), "header", "uncertain", "90002", "李四").unwrap();
    let c =
        save_debug_shot_into(&dir, &shot(300, 40), "dropdown", "choice2_LocalOCR", "90003", "王五").unwrap();

    assert_ne!(a, b);
    assert_ne!(b, c);
    for p in [&a, &b, &c] {
        assert!(p.exists(), "归档文件未落盘：{}", p.display());
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_sanitize_falls_back_when_name_is_all_illegal() {
    // 全是空白/非法字符时不能退化成空文件名（会写成 .png）
    assert_eq!(sanitize_filename("   ///   "), "unknown");
    assert_eq!(sanitize_filename(""), "unknown");
    assert_eq!(sanitize_filename("张三"), "张三");
}

// ================================================================
// 错误传播：诊断旁路不能 panic，但也不能吞掉失败原因
// ================================================================

#[test]
fn test_returns_specific_error_instead_of_silent_none() {
    let dir = tmp_dir("err");

    // 父路径是普通文件而非目录 -> 建目录必失败
    let blocker = dir.join("blocker");
    std::fs::write(&blocker, b"x").unwrap();
    let res = save_debug_shot_into(&blocker.join("shots"), &shot(200, 40), "header", "mismatch", "1", "a");

    match res {
        Err(DebugShotError::CreateDir { context, .. }) => {
            assert!(
                context.contains("目录") || context.contains("dir"),
                "错误信息应说明是目录创建失败，实际：{context}"
            );
            // 错误链要能追到根因，否则「为什么存不下」仍然无从查起
            let e: &dyn std::error::Error = &res.err().unwrap();
            assert!(
                e.source().is_some(),
                "CreateDir 应保留底层 io::Error 作为 error chain的一环"
            );
        }
        other => panic!("应返回 CreateDir 错误，实际 {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ================================================================
// 时间戳（与日志同源，保证截图与日志能对上同一时刻）
// ================================================================

#[test]
fn test_compact_timestamp_is_filename_safe() {
    let ts = timestamp_compact();
    assert_eq!(ts.len(), 15, "应为 YYYYMMDD_HHMMSS，实际 {ts}");
    assert_eq!(&ts[8..9], "_", "日期与时间之间缺分隔：{ts}");
    for (i, c) in ts.chars().enumerate() {
        if i == 8 {
            continue;
        }
        assert!(c.is_ascii_digit(), "非数字出现在 {i}：{ts}");
    }
    // 文件名安全：不含任何 Windows 非法字符
    for bad in [":", " ", "/", "\\"] {
        assert!(!ts.contains(bad), "时间戳含文件名非法字符 {bad:?}：{ts}");
    }
}

// ================================================================
// 数据目录回退链
// ================================================================

#[test]
fn test_data_dir_always_returns_usable_directory() {
    // 无论环境变量多么离谱（指向不可写位置），都必须退回一个能建的目录，
    // 否则日志与截图会双双失效
    let dir = data_dir();
    assert!(dir.exists(), "数据目录未创建成功：{}", dir.display());
    assert!(
        std::fs::create_dir_all(&dir).is_ok(),
        "数据目录不可写：{}",
        dir.display()
    );
    assert!(
        dir.ends_with("JFFeedback"),
        "目录名应与经典版保持一致：{}",
        dir.display()
    );
}

#[test]
fn test_debug_img_dir_sits_under_data_dir() {
    let d = data_dir();
    let shots = d.join("debug_screenshots");
    assert_eq!(shots.parent(), Some(d.as_path()));
}