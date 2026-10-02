use desktop_sender_rs::commands::{handle_load_data_file, AppState};
use desktop_sender_rs::sender_engine::EngineCommand;
use std::fs;
use std::io::Write;

#[test]
fn test_app_state_command_signaling() {
    let state = AppState::default();
    assert!(state.cmd_tx.lock().unwrap().is_none());

    let (tx, mut rx) = tokio::sync::watch::channel(EngineCommand::Start);
    *state.cmd_tx.lock().unwrap() = Some(tx);

    if let Some(ref tx) = *state.cmd_tx.lock().unwrap() {
        let _ = tx.send(EngineCommand::Pause);
    }
    assert_eq!(*rx.borrow_and_update(), EngineCommand::Pause);
}

#[test]
fn test_handle_load_data_file_json() {
    let tmp_dir = std::env::temp_dir();
    let file_path = tmp_dir.join("test_feedbacks_1.json");

    let sample_json = r#"[
        {
            "studentName": "99001赵六",
            "message": "赵六家长您好，以下是小赵第4周作业反馈。\n【错题本】：https://vip.wxjifang.cn/retest.html?token=abc"
        }
    ]"#;
    fs::write(&file_path, sample_json).unwrap();

    let items = handle_load_data_file(file_path.to_str().unwrap()).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].student_id, "99001");
    assert_eq!(items[0].clean_name, "赵六");
    assert_eq!(items[0].cycle, "第4周");

    let _ = fs::remove_file(file_path);
}

#[test]
fn test_handle_load_data_file_html() {
    let tmp_dir = std::env::temp_dir();
    let file_path = tmp_dir.join("test_feedbacks_2.html");

    let sample_html = r#"
    <!DOCTYPE html>
    <html>
    <body>
        <div class="feedback-card">
            <h3 class="student-name">88002钱七</h3>
            <pre class="message-body">钱七家长好，第5周作业已批阅完毕。</pre>
        </div>
    </body>
    </html>
    "#;
    let mut f = fs::File::create(&file_path).unwrap();
    f.write_all(sample_html.as_bytes()).unwrap();

    let items = handle_load_data_file(file_path.to_str().unwrap()).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].student_id, "88002");
    assert_eq!(items[0].clean_name, "钱七");
    assert_eq!(items[0].cycle, "第5周");

    let _ = fs::remove_file(file_path);
}
