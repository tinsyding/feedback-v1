#include "../src/parser.h"
#include "../src/image_proc.h"
#include "../src/history_manager.h"
#include <iostream>
#include <cassert>
#include <filesystem>

using namespace feedback;

void test_parse_student_identifier() {
    std::cout << "[Test 1] 测试学号与姓名拆分算法...\n";
    {
        auto [id, name] = parse_student_identifier("90001张三");
        assert(id == "90001");
        assert(name == "张三");
    }
    {
        auto [id, name] = parse_student_identifier("90002 - 李四");
        assert(id == "90002");
        assert(name == "李四");
    }
    {
        auto [id, name] = parse_student_identifier("90003、王五");
        assert(id == "90003");
        assert(name == "王五");
    }
    {
        auto [id, name] = parse_student_identifier("赵六");
        assert(id == "");
        assert(name == "赵六");
    }
    std::cout << "  ✓ 学号姓名拆分测试 100% 通过\n";
}

void test_detect_cycle() {
    std::cout << "[Test 2] 测试周次智能识别提取...\n";
    assert(detect_cycle_from_string("8MA+43第2周.html") == "第 2 周");
    assert(detect_cycle_from_string("8MA+43第15周.html") == "第 15 周");
    assert(detect_cycle_from_string("第 5 讲课后作业") == "第 5 讲");
    assert(detect_cycle_from_string("Week 3 Feedback") == "第 3 周");
    assert(detect_cycle_from_string("班级反馈 W04.json") == "第 4 周");
    assert(detect_cycle_from_string("普通未标注文件.html") == "");
    std::cout << "  ✓ 周次识别测试 100% 通过\n";
}

void test_contact_candidate_decision() {
    std::cout << "[Test 3] 测试防误发智能候选决策中枢...\n";

    // 1. 首项即为本人
    {
        std::vector<ContactCandidate> list = {
            {1, "90001张三", {}, false, false},
            {2, "李四", {}, false, false}
        };
        auto res = evaluate_contact_candidates(list, "90001", "张三", "Test");
        assert(res.choice == 1);
    }

    // 2. 首项为他人描述，第2项为本人 -> 自动纠偏 choice = 2
    {
        std::vector<ContactCandidate> list = {
            {1, "王五", {"聊天记录: 提及了90001张三"}, true, false},
            {2, "90001张三", {}, false, false}
        };
        auto res = evaluate_contact_candidates(list, "90001", "张三", "Test");
        assert(res.choice == 2);
    }

    // 3. 结果全是他人描述 -> 智能拦截 choice = -2
    {
        std::vector<ContactCandidate> list = {
            {1, "王五", {"聊天记录: 提及了90001张三"}, true, false},
            {2, "赵六", {"群聊提及: 90001"}, true, false}
        };
        auto res = evaluate_contact_candidates(list, "90001", "张三", "Test");
        assert(res.choice == -2);
    }

    // 4. 无匹配项 -> 安全跳过 choice = 0
    {
        std::vector<ContactCandidate> list = {
            {1, "搜索网络结果", {}, false, false},
            {2, "查找更多联系人", {}, false, false}
        };
        auto res = evaluate_contact_candidates(list, "90001", "张三", "Test");
        assert(res.choice == 0);
    }

    std::cout << "  ✓ 防误发决策中枢测试 100% 通过\n";
}

void test_image_preprocessing() {
    std::cout << "[Test 4] 测试图像去水印与双三次放大管线...\n";
    RawImage img;
    img.width = 4;
    img.height = 4;
    img.channels = 1;
    img.data = {
        210, 220, 230, 240,
        50,  60,  215, 225,
        100, 110, 208, 209,
        30,  40,  250, 255
    };

    auto cleaned = remove_watermark(img, 205);
    // > 205 应被擦除为 255，小字笔画应保留
    assert(cleaned.data[0] == 255);
    assert(cleaned.data[1] == 255);
    assert(cleaned.data[4] == 50);
    assert(cleaned.data[5] == 60);

    auto scaled = resize_bicubic_2x(cleaned);
    assert(scaled.width == 8);
    assert(scaled.height == 8);
    assert(scaled.data.size() == 64);
    std::cout << "  ✓ 图像预处理与放大测试 100% 通过\n";
}

void test_history_manager() {
    std::cout << "[Test 5] 测试历史档案持久化与 CSV 导出...\n";
    std::string test_db = "./temp_test_history.json";
    std::string test_csv = "./temp_test_export.csv";

    if (std::filesystem::exists(test_db)) std::filesystem::remove(test_db);
    if (std::filesystem::exists(test_csv)) std::filesystem::remove(test_csv);

    {
        HistoryManager mgr(test_db);
        std::vector<FeedbackItem> items = {
            {"90001张三", "评语1", "90001", "张三", "第 1 周", SendStatus::Pending, 0},
            {"90002李四", "评语2", "90002", "李四", "第 1 周", SendStatus::Pending, 1}
        };
        mgr.sync_file_loaded("8MA+43第1周.html", items, "第 1 周");
        mgr.update_student_status("8MA+43第1周 [第 1 周]", "90001", "张三", "已发送 ✓", "");

        auto st = mgr.get_student_status("8MA+43第1周 [第 1 周]", "90001", "张三");
        assert(st.has_value() && *st == "已发送 ✓");

        bool csv_ok = mgr.export_csv("8MA+43第1周 [第 1 周]", test_csv);
        assert(csv_ok);
        assert(std::filesystem::exists(test_csv));
    }

    // 清理临时文件
    if (std::filesystem::exists(test_db)) std::filesystem::remove(test_db);
    if (std::filesystem::exists(test_csv)) std::filesystem::remove(test_csv);
    std::cout << "  ✓ 历史管理与报表导出测试 100% 通过\n";
}

int main() {
    std::cout << "==========================================\n";
    std::cout << "  运行 C++ 重构版完整单元测试套件\n";
    std::cout << "==========================================\n";

    test_parse_student_identifier();
    test_detect_cycle();
    test_contact_candidate_decision();
    test_image_preprocessing();
    test_history_manager();

    std::cout << "\n>>> 所有单元测试全部 100% PASS！<<<\n";
    return 0;
}
