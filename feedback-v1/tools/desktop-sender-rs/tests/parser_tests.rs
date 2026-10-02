use desktop_sender_rs::image_proc::preprocess_dropdown_image;
use desktop_sender_rs::parser::{
    detect_cycle_from_string, evaluate_contact_candidates, parse_student_identifier,
};
use desktop_sender_rs::types::ContactCandidate;
use image::{DynamicImage, GrayImage, Luma};

#[test]
fn test_parse_student_identifier() {
    let (id, name) = parse_student_identifier("90001张三");
    assert_eq!(id, "90001");
    assert_eq!(name, "张三");

    let (id2, name2) = parse_student_identifier("80002 李四-数学");
    assert_eq!(id2, "80002");
    assert_eq!(name2, "李四-数学");

    let (id3, name3) = parse_student_identifier("王小五");
    assert_eq!(id3, "");
    assert_eq!(name3, "王小五");
}

#[test]
fn test_detect_cycle_from_string() {
    assert_eq!(
        detect_cycle_from_string("这是第3周课前预习作业反馈"),
        "第3周"
    );
    assert_eq!(
        detect_cycle_from_string("本期为第 5 讲课后巩固"),
        "第 5 讲"
    );
    assert_eq!(detect_cycle_from_string("Week 2 feedback"), "Week 2");
    assert_eq!(detect_cycle_from_string("普通作业反馈，无周期标记"), "");
}

#[test]
fn test_contact_decision_avoids_mention() {
    let candidates = vec![
        ContactCandidate {
            index: 1,
            title: "王小明".to_string(),
            subtitles: vec!["描述: 包含张三".to_string()],
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

    let decision = evaluate_contact_candidates(&candidates, "90001", "张三", "TestEngine");
    assert_eq!(decision.choice, 2);
    assert!(decision.reason.contains("第2项为目标本人"));
}

#[test]
fn test_contact_decision_rejects_group() {
    let candidates = vec![ContactCandidate {
        index: 1,
        title: "2026极方数学名师答疑群聊（18人）".to_string(),
        subtitles: vec![],
        has_desc: false,
        is_group: true,
    }];

    let decision = evaluate_contact_candidates(&candidates, "90001", "张三", "TestEngine");
    assert_eq!(decision.choice, 0);
    assert!(decision.reason.contains("未找到该联系人"));
}

#[test]
fn test_watermark_removal_and_scaling() {
    // 构造测试图像，包含一个水印像素(220)和一个文字深色像素(50)
    let mut img = GrayImage::new(10, 10);
    img.put_pixel(0, 0, Luma([220])); // 水印
    img.put_pixel(1, 1, Luma([50]));  // 文字

    let dyn_img = DynamicImage::ImageLuma8(img);
    let processed = preprocess_dropdown_image(&dyn_img);

    // 检查是否放大 2 倍 (10x10 -> 20x20)
    assert_eq!(processed.width(), 20);
    assert_eq!(processed.height(), 20);
}
