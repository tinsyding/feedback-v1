use desktop_sender_rs::automation::{find_wecom_window, is_windows_ocr_available};
use desktop_sender_rs::parser::{evaluate_contact_candidates, parse_json};
use desktop_sender_rs::types::ContactCandidate;
use std::fs;
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== 极方每周反馈程序 (Rust 原生重构版 PoC) ===");

    // 1. 测试解析本地数据
    let test_json_path = Path::new("../desktop-sender/测试.json");
    if test_json_path.exists() {
        let content = fs::read_to_string(test_json_path)?;
        let items = parse_json(&content)?;
        println!("成功解析学生名单数量: {}", items.len());
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
    } else {
        println!("未检测到测试数据: {}", test_json_path.display());
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

    println!("\nPoC 基础逻辑校验 100% 通过！");
    Ok(())
}
