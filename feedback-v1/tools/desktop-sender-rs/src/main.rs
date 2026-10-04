#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use desktop_sender_rs::automation::{find_wecom_window, is_windows_ocr_available};
use desktop_sender_rs::parser::{evaluate_contact_candidates, parse_json};
use desktop_sender_rs::types::ContactCandidate;
use std::fs;
use std::path::Path;

#[cfg(windows)]
fn run_gui() {
    use desktop_sender_rs::commands::tauri_bridge::*;
    use desktop_sender_rs::commands::AppState;

    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            check_wecom_status,
            load_data_file,
            start_send,
            pause_send,
            resume_send,
            stop_send,
            upload_diagnostic_logs,
            read_local_log,
        ])
        .run(tauri::generate_context!())
        .expect("运行极方反馈程序 GUI 失败");
}

fn run_cli_diagnostics() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== 极方每周反馈程序 (Rust 原生重构版 CLI 诊断模式) ===");

    // 1. 测试解析本地数据
    let test_json_paths = [
        Path::new("../desktop-sender/测试.json"),
        Path::new("tests/fixtures/test_records.json"),
    ];

    let mut found_data = false;
    for path in &test_json_paths {
        if path.exists() {
            let content = fs::read_to_string(path)?;
            let items = parse_json(&content)?;
            println!("成功解析学生名单数量: {} (来源: {})", items.len(), path.display());
            for (i, item) in items.iter().enumerate() {
                println!(
                    "  [{}] 学号: {:<6} 姓名: {:<6} 周期: {:<6} 文案长度: {} 字",
                    i + 1,
                    item.student_id,
                    item.clean_name,
                    item.cycle,
                    item.message.chars().count()
                );
            }
            found_data = true;
            break;
        }
    }
    if !found_data {
        println!("未检测到本地测试数据集");
    }

    // 2. 检测系统原生能力
    println!("\n=== 环境能力诊断 ===");
    println!("Windows 原生 OCR 支持: {}", is_windows_ocr_available());
    let wecom_hwnd = find_wecom_window();
    println!("企业微信主窗口句柄: {:?}", wecom_hwnd);

    // 3. 测试防误发智能候选决策中枢
    println!("\n=== 防误发决策中枢自测 ===");
    let mock_candidates = vec![
        ContactCandidate {
            index: 1,
            title: "李四".to_string(),
            subtitles: vec!["描述: 提到了张三".to_string()],
            has_desc: true,
            is_group: false,
        },
        ContactCandidate {
            index: 2,
            title: "90001张三".to_string(),
            subtitles: vec![],
            has_desc: false,
            is_group: false,
        },
    ];
    let decision = evaluate_contact_candidates(&mock_candidates, "90001", "张三", "SelfTest");
    println!("决策结果: {:?}", decision);
    assert_eq!(decision.choice, 2, "应自动避开第1项他人描述，选中第2项本人");

    println!("\nCLI 基础逻辑与诊断校验 100% 通过！");
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let _is_cli = args.iter().any(|a| a == "--cli" || a == "-c");

    #[cfg(windows)]
    if !_is_cli {
        run_gui();
        return Ok(());
    }

    run_cli_diagnostics()
}
