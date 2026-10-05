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

    let decision = evaluate_contact_candidates(&candidates, "90001", "张三", "TestEngine", "");
    assert_eq!(decision.choice, 2);
    assert!(decision.reason.contains("第2项为目标本人"));
}

#[test]
fn test_contact_decision_allows_target_with_own_description() {
    let candidates = vec![
        ContactCandidate {
            index: 1,
            title: "90001张三@微信".to_string(),
            subtitles: vec!["微信昵称: cocoons".to_string(), "描述: 2026学员".to_string()],
            has_desc: true,
            is_group: false,
        },
        ContactCandidate {
            index: 2,
            title: "80001李四@微信".to_string(),
            subtitles: vec![],
            has_desc: false,
            is_group: false,
        },
    ];

    let decision = evaluate_contact_candidates(&candidates, "90001", "张三", "TestEngine", "");
    assert_eq!(decision.choice, 1);
    assert!(decision.reason.contains("第1项即为目标本人"));
}

#[test]
fn test_contact_decision_requires_both_id_and_name() {
    let candidates = vec![
        ContactCandidate {
            index: 1,
            title: "90001李四@微信".to_string(), // 仅学号对，姓名不对
            subtitles: vec![],
            has_desc: false,
            is_group: false,
        },
        ContactCandidate {
            index: 2,
            title: "张三@微信".to_string(), // 仅姓名对，学号不对
            subtitles: vec![],
            has_desc: false,
            is_group: false,
        },
        ContactCandidate {
            index: 3,
            title: "90001张三@微信".to_string(), // 完全同时匹配学号+姓名！
            subtitles: vec![],
            has_desc: false,
            is_group: false,
        },
    ];

    let decision = evaluate_contact_candidates(&candidates, "90001", "张三", "TestEngine", "");
    assert_eq!(decision.choice, 3);
    assert!(decision.reason.contains("第3项为目标本人"));
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

    // 只有群聊候选、且下拉文本里没有任何「查无此人」的证据：
    // 这是「我没找到」，不是「通讯录里没这个人」→ 必须 -1，绝不能 0。
    // choice=0 会把学生记为「无此联系人」并跳过，那正是要修的误判。
    let decision = evaluate_contact_candidates(&candidates, "90001", "张三", "TestEngine", "群聊 2026极方数学名师答疑群聊（18人）");
    assert_eq!(
        decision.choice, -1,
        "无查无此人证据时不得断言查无此人"
    );
    assert!(decision.reason.contains("按识别失败处理"));
}

#[test]
fn test_contact_decision_not_found_requires_positive_evidence() {
    // 同一个候选集：只有带上企微真实空态文案，才允许判「查无此人」。
    let group_only = vec![ContactCandidate {
        index: 1,
        title: "2026极方数学名师答疑群聊（18人）".to_string(),
        subtitles: vec![],
        has_desc: false,
        is_group: true,
    }];

    let d = evaluate_contact_candidates(
        &group_only,
        "90001",
        "张三",
        "TestEngine",
        "群聊 2026极方数学名师答疑群聊（18人）进入全局搜索查找所有聊天、邮件、文档、微盘等",
    );
    assert_eq!(d.choice, 0, "有正向证据时才可判查无此人");
    assert!(d.reason.contains("显示全局搜索"));
}

#[test]
fn test_contact_decision_empty_candidates_without_text_is_recognition_failure() {
    // 现场事故：RapidOCR 引擎起不来，下拉文本为空。旧实现直接判 0
    // 「未找到该联系人」，把引擎故障说成了通讯录里没这个人。
    let d = evaluate_contact_candidates(&[], "26006", "陈锦曦", "LocalOCR", "");
    assert_eq!(d.choice, -1, "引擎故障绝不可谎报为查无此人");
    assert!(d.reason.contains("按识别失败处理"));
}

#[test]
fn test_chat_preview_saying_not_found_is_not_evidence() {
    // 「未找到 / 无结果 / 暂无结果」这类泛化否定词会出现在聊天预览、
    // 文档名、群公告里。若把它们当证据，真实存在的学生会被误判为查无此人
    // 并跳过 —— 比漏发更隐蔽，故刻意不收。
    for text in [
        "老板（企微）未找到该文件",
        "同事 无结果 2026秋",
        "群里 暂无结果 报名",
        "没有找到 相关聊天记录",
    ] {
        let d = evaluate_contact_candidates(&[], "26006", "陈锦曦", "LocalOCR", text);
        assert_eq!(d.choice, -1, "聊天预览里的否定词不该被当成查无此人证据: {text}");
    }
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

#[test]
fn test_parse_ocr_lines_to_contacts() {
    use desktop_sender_rs::automation::{parse_ocr_lines_to_contacts, OcrLine};

    let lines = vec![
        OcrLine { text: "联系人".to_string(), ..Default::default() },
        OcrLine { text: "王小明".to_string(), ..Default::default() },
        OcrLine { text: "描述: 提到张三".to_string(), ..Default::default() },
        OcrLine { text: "90001张三".to_string(), ..Default::default() },
        OcrLine { text: "群聊".to_string(), ..Default::default() },
        OcrLine { text: "极方教师教研群".to_string(), ..Default::default() },
    ];
    let full_text = "联系人 王小明 描述:提到张三 90001张三 群聊 极方教师教研群";

    let contacts = parse_ocr_lines_to_contacts(&lines, full_text);
    assert_eq!(contacts.len(), 2);
    assert_eq!(contacts[0].title, "王小明");
    assert!(contacts[0].has_desc);
    assert_eq!(contacts[1].title, "90001张三");
    assert!(!contacts[1].has_desc);
}

#[test]
fn test_ocr_phantoms_do_not_shift_target_position() {
    use desktop_sender_rs::automation::{parse_ocr_lines_to_contacts, OcrLine};

    // 现场还原：搜索框占位“搜索” + 描述行跑到标题前 + 尾部“查看全部”按钮。
    // 这些行都不能建成候选占位，否则真实目标被挤后、多按向下键。
    let lines = vec![
        OcrLine { text: "联系人".to_string(), ..Default::default() },
        OcrLine { text: "搜索".to_string(), ..Default::default() },
        OcrLine { text: "描述: 90001张三的备注".to_string(), ..Default::default() },
        OcrLine { text: "90001张三".to_string(), ..Default::default() },
        OcrLine { text: "查看全部".to_string(), ..Default::default() },
        OcrLine { text: "80002李四".to_string(), ..Default::default() },
    ];
    let full_text = "联系人 搜索 描述:90001张三的备注 90001张三 查看全部 80002李四";

    let contacts = parse_ocr_lines_to_contacts(&lines, full_text);
    assert_eq!(contacts.len(), 1, "只应剩真实目标，铬屑与空标题不得占位");
    assert_eq!(contacts[0].title, "90001张三");
    assert_eq!(contacts[0].index, 1);
    // 前置描述行应合并挂靠到目标名下
    assert!(contacts[0].has_desc);
    assert_eq!(contacts[0].subtitles.len(), 1);

    let decision =
        evaluate_contact_candidates(&contacts, "90001", "张三", "TestEngine", "");
    assert_eq!(decision.choice, 1, "首项即本人时必须直接回车，不得按向下");
}

#[test]
fn test_ocr_geometry_filter_drops_watermark_lines() {
    use desktop_sender_rs::automation::{
        parse_ocr_lines_to_contacts_at_scale, OcrLine,
    };

    // 正常文字列 x≈60；右侧水印列 x≈900（100% 基准下 >360 应被剔除）
    let lines = vec![
        OcrLine { text: "联系人".to_string(), x_min: 60.0, y_center: 10.0 },
        OcrLine { text: "90001张三".to_string(), x_min: 60.0, y_center: 40.0 },
        OcrLine { text: "极方教育防泄密水印".to_string(), x_min: 900.0, y_center: 40.0 },
    ];
    let full = "联系人90001张三极方教育防泄密水印";
    let contacts = parse_ocr_lines_to_contacts_at_scale(&lines, full, 1.0);
    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0].title, "90001张三");
    assert_eq!(contacts[0].index, 1);
}
