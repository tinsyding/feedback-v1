#include "main_window.h"

#ifdef FEEDBACK_QT_AVAILABLE

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QSplitter>
#include <QFileDialog>
#include <QMessageBox>
#include <QMenuBar>
#include <QHeaderView>
#include <QDateTime>
#include <fstream>
#include "../parser.h"

namespace feedback {

MainWindow::MainWindow(QWidget* parent)
    : QMainWindow(parent)
    , driver_(create_automation_driver())
    , history_mgr_(std::make_shared<HistoryManager>())
    , engine_(std::make_unique<SenderEngine>(driver_))
{
    engine_->set_history_manager(history_mgr_);
    setup_ui();

    // 引擎回调投递至 Qt UI 线程
    engine_->set_log_callback([this](const std::string& msg, const std::string& level) {
        QMetaObject::invokeMethod(this, [this, msg = QString::fromStdString(msg), level = QString::fromStdString(level)]() {
            append_log(msg, level);
        }, Qt::QueuedConnection);
    });

    engine_->set_progress_callback([this](size_t current, size_t total, const FeedbackItem& item) {
        QMetaObject::invokeMethod(this, [this, current, total, name = QString::fromStdString(item.student_name)]() {
            progress_bar_->setMaximum(static_cast<int>(total));
            progress_bar_->setValue(static_cast<int>(current));
            status_label_->setText(QString("正在发送 (%1/%2): %3").arg(current).arg(total).arg(name));
        }, Qt::QueuedConnection);
    });

    engine_->set_item_finished_callback([this](size_t index, SendStatus status, const std::string& reason) {
        QMetaObject::invokeMethod(this, [this, index, status, reason = QString::fromStdString(reason)]() {
            if (index < current_items_.size()) {
                current_items_[index].status = status;
                QString status_str = "待发送";
                if (status == SendStatus::Success) status_str = "已发送 ✓";
                else if (status == SendStatus::Failed) status_str = "发送失败 ✕";
                else if (status == SendStatus::Skipped) status_str = "安全跳过 ⚠️";
                table_model_->item(static_cast<int>(index), 4)->setText(status_str);
            }
        }, Qt::QueuedConnection);
    });

    engine_->set_state_changed_callback([this](EngineState state) {
        QMetaObject::invokeMethod(this, [this, state]() {
            bool is_running = (state == EngineState::Running);
            bool is_paused = (state == EngineState::Paused);
            btn_start_->setEnabled(!is_running && !is_paused && !current_items_.empty());
            btn_pause_->setEnabled(is_running);
            btn_resume_->setEnabled(is_paused);
            btn_stop_->setEnabled(is_running || is_paused);
            btn_retry_->setEnabled(!is_running && !is_paused && !current_items_.empty());
        }, Qt::QueuedConnection);
    });
}

MainWindow::~MainWindow() {
    if (engine_) {
        engine_->stop();
    }
}

void MainWindow::setup_ui() {
    setWindowTitle("极方每周反馈程序 (C++ & Qt 原生版)");
    resize(1100, 720);

    // 菜单栏
    QMenu* file_menu = menuBar()->addMenu("文件 (&F)");
    file_menu->addAction("载入数据文件 (JSON / HTML)...", this, &MainWindow::on_open_file, QKeySequence::Open);
    file_menu->addAction("导出 CSV 报表...", this, &MainWindow::on_export_csv);
    file_menu->addSeparator();
    file_menu->addAction("退出 (&X)", this, &QWidget::close);

    QWidget* central_widget = new QWidget(this);
    setCentralWidget(central_widget);
    QVBoxLayout* main_layout = new QVBoxLayout(central_widget);

    // 顶部工具栏
    QHBoxLayout* top_layout = new QHBoxLayout();
    QPushButton* btn_open = new QPushButton("📂 载入文件", this);
    connect(btn_open, &QPushButton::clicked, this, &MainWindow::on_open_file);
    top_layout->addWidget(btn_open);

    file_label_ = new QLabel("未载入任何文件", this);
    file_label_->setStyleSheet("color: #666; font-size: 13px;");
    top_layout->addWidget(file_label_, 1);

    top_layout->addWidget(new QLabel("当前发送周次:", this));
    cycle_combo_ = new QComboBox(this);
    for (int w = 1; w <= 24; ++w) {
        cycle_combo_->addItem(QString("第 %1 周").arg(w));
    }
    connect(cycle_combo_, &QComboBox::currentTextChanged, this, &MainWindow::on_cycle_changed);
    top_layout->addWidget(cycle_combo_);

    main_layout->addLayout(top_layout);

    // 中间分割面板
    QSplitter* main_splitter = new QSplitter(Qt::Horizontal, this);

    // 左侧：学生表格
    QWidget* left_widget = new QWidget(this);
    QVBoxLayout* left_layout = new QVBoxLayout(left_widget);
    left_layout->setContentsMargins(0, 0, 0, 0);

    table_view_ = new QTableView(this);
    table_model_ = new QStandardItemModel(this);
    table_model_->setHorizontalHeaderLabels({"选择", "学号", "姓名", "归属周次", "状态"});
    table_view_->setModel(table_model_);
    table_view_->setSelectionBehavior(QAbstractItemView::SelectRows);
    table_view_->setSelectionMode(QAbstractItemView::SingleSelection);
    table_view_->horizontalHeader()->setStretchLastSection(true);
    connect(table_view_->selectionModel(), &QItemSelectionModel::selectionChanged,
            this, &MainWindow::on_table_selection_changed);
    left_layout->addWidget(table_view_);
    main_splitter->addWidget(left_widget);

    // 右侧：文案预览 + 运行日志
    QSplitter* right_splitter = new QSplitter(Qt::Vertical, this);

    QWidget* preview_box = new QWidget(this);
    QVBoxLayout* preview_layout = new QVBoxLayout(preview_box);
    preview_layout->setContentsMargins(0, 0, 0, 0);
    preview_layout->addWidget(new QLabel("实时文案预览:", this));
    preview_browser_ = new QTextBrowser(this);
    preview_browser_->setPlaceholderText("在左侧名单中选择学生，即可在此预览该学生的专属反馈文案与落地页链接...");
    preview_layout->addWidget(preview_browser_);
    right_splitter->addWidget(preview_box);

    QWidget* log_box = new QWidget(this);
    QVBoxLayout* log_layout = new QVBoxLayout(log_box);
    log_layout->setContentsMargins(0, 0, 0, 0);
    log_layout->addWidget(new QLabel("执行日志与视觉防御审计:", this));
    log_edit_ = new QPlainTextEdit(this);
    log_edit_->setReadOnly(true);
    log_layout->addWidget(log_edit_);
    right_splitter->addWidget(log_box);

    right_splitter->setSizes({350, 250});
    main_splitter->addWidget(right_splitter);
    main_splitter->setSizes({550, 550});

    main_layout->addWidget(main_splitter, 1);

    // 底部控制与进度栏
    QVBoxLayout* bottom_layout = new QVBoxLayout();
    QHBoxLayout* progress_layout = new QHBoxLayout();
    progress_bar_ = new QProgressBar(this);
    progress_bar_->setValue(0);
    progress_layout->addWidget(progress_bar_, 1);
    status_label_ = new QLabel("就绪", this);
    progress_layout->addWidget(status_label_);
    bottom_layout->addLayout(progress_layout);

    QHBoxLayout* btn_layout = new QHBoxLayout();
    btn_start_ = new QPushButton("▶ 开始发送", this);
    btn_start_->setEnabled(false);
    btn_start_->setStyleSheet("font-weight: bold; background-color: #2e7d32; color: white; padding: 6px 16px;");
    connect(btn_start_, &QPushButton::clicked, this, &MainWindow::on_start_clicked);
    btn_layout->addWidget(btn_start_);

    btn_pause_ = new QPushButton("⏸ 暂停", this);
    btn_pause_->setEnabled(false);
    connect(btn_pause_, &QPushButton::clicked, this, &MainWindow::on_pause_clicked);
    btn_layout->addWidget(btn_pause_);

    btn_resume_ = new QPushButton("⏯ 恢复", this);
    btn_resume_->setEnabled(false);
    connect(btn_resume_, &QPushButton::clicked, this, &MainWindow::on_resume_clicked);
    btn_layout->addWidget(btn_resume_);

    btn_stop_ = new QPushButton("⏹ 停止", this);
    btn_stop_->setEnabled(false);
    connect(btn_stop_, &QPushButton::clicked, this, &MainWindow::on_stop_clicked);
    btn_layout->addWidget(btn_stop_);

    btn_retry_ = new QPushButton("🔄 一键重试失败/拦截项", this);
    btn_retry_->setEnabled(false);
    connect(btn_retry_, &QPushButton::clicked, this, &MainWindow::on_retry_failed_clicked);
    btn_layout->addWidget(btn_retry_);

    btn_layout->addStretch();
    bottom_layout->addLayout(btn_layout);

    main_layout->addLayout(bottom_layout);
}

void MainWindow::on_open_file() {
    QString path = QFileDialog::getOpenFileName(
        this,
        "选择反馈数据文件",
        "",
        "反馈数据文件 (*.json *.html *.htm);;JSON 文件 (*.json);;HTML 快照 (*.html *.htm)"
    );
    if (!path.isEmpty()) {
        load_file(path);
    }
}

void MainWindow::load_file(const QString& path) {
    std::ifstream ifs(path.toStdString());
    if (!ifs.is_open()) {
        QMessageBox::critical(this, "错误", "无法打开文件: " + path);
        return;
    }
    std::string content((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());

    std::vector<FeedbackItem> items;
    if (path.endsWith(".json", Qt::CaseInsensitive)) {
        items = parse_json(content);
    } else {
        items = parse_html(content);
    }

    if (items.empty()) {
        QMessageBox::warning(this, "警告", "未能从文件中解析出有效的学生反馈数据！");
        return;
    }

    current_file_path_ = path;
    file_label_->setText(QFileInfo(path).fileName());

    // 智能提取周次并切换
    QString detected_cycle = QString::fromStdString(detect_cycle_from_string(QFileInfo(path).fileName().toStdString()));
    if (detected_cycle.isEmpty() && !items[0].cycle.empty()) {
        detected_cycle = QString::fromStdString(items[0].cycle);
    }
    if (!detected_cycle.isEmpty()) {
        int idx = cycle_combo_->findText(detected_cycle);
        if (idx >= 0) {
            cycle_combo_->setCurrentIndex(idx);
        } else {
            cycle_combo_->addItem(detected_cycle);
            cycle_combo_->setCurrentText(detected_cycle);
        }
    }

    current_items_ = std::move(items);
    current_archive_key_ = QString::fromStdString(
        history_mgr_->resolve_archive_key(path.toStdString(), cycle_combo_->currentText().toStdString())
    );

    history_mgr_->sync_file_loaded(path.toStdString(), current_items_, cycle_combo_->currentText().toStdString());

    update_table_view();
    btn_start_->setEnabled(true);
    btn_retry_->setEnabled(true);
    append_log(QString("成功载入文件: %1, 解析学生名单数: %2").arg(QFileInfo(path).fileName()).arg(current_items_.size()), "INFO");
}

void MainWindow::update_table_view() {
    table_model_->removeRows(0, table_model_->rowCount());

    for (size_t i = 0; i < current_items_.size(); ++i) {
        const auto& item = current_items_[i];

        auto st_opt = history_mgr_->get_student_status(current_archive_key_.toStdString(), item.student_id, item.clean_name);
        QString status_str = st_opt.has_value() ? QString::fromStdString(*st_opt) : "待发送";

        QList<QStandardItem*> row;
        auto* chk = new QStandardItem();
        chk->setCheckable(true);
        chk->setCheckState(status_str.contains("已发送") ? Qt::Unchecked : Qt::Checked);
        row.append(chk);

        row.append(new QStandardItem(QString::fromStdString(item.student_id)));
        row.append(new QStandardItem(QString::fromStdString(item.clean_name)));
        row.append(new QStandardItem(cycle_combo_->currentText()));
        row.append(new QStandardItem(status_str));

        table_model_->appendRow(row);
    }
}

void MainWindow::on_cycle_changed(const QString& cycle) {
    if (current_file_path_.isEmpty()) return;
    current_archive_key_ = QString::fromStdString(
        history_mgr_->resolve_archive_key(current_file_path_.toStdString(), cycle.toStdString())
    );
    history_mgr_->sync_file_loaded(current_file_path_.toStdString(), current_items_, cycle.toStdString());
    update_table_view();
    append_log("周次已切换为: " + cycle + "，已自动同步该周次独立发送状态", "INFO");
}

void MainWindow::on_table_selection_changed(const QItemSelection& selected, const QItemSelection& /*deselected*/) {
    if (selected.indexes().isEmpty()) {
        preview_browser_->clear();
        return;
    }
    int row = selected.indexes().first().row();
    if (row >= 0 && row < static_cast<int>(current_items_.size())) {
        preview_browser_->setPlainText(QString::fromStdString(current_items_[row].message));
    }
}

void MainWindow::on_start_clicked() {
    std::vector<FeedbackItem> to_send;
    for (int i = 0; i < table_model_->rowCount(); ++i) {
        if (table_model_->item(i, 0)->checkState() == Qt::Checked) {
            to_send.push_back(current_items_[i]);
        }
    }

    if (to_send.empty()) {
        QMessageBox::information(this, "提示", "未勾选任何需要发送的学生！");
        return;
    }

    engine_->set_archive_key(current_archive_key_.toStdString());
    engine_->set_items(std::move(to_send));
    engine_->start();
}

void MainWindow::on_pause_clicked() {
    engine_->pause();
}

void MainWindow::on_resume_clicked() {
    engine_->resume();
}

void MainWindow::on_stop_clicked() {
    engine_->stop();
}

void MainWindow::on_retry_failed_clicked() {
    std::vector<FeedbackItem> retry_items;
    for (int i = 0; i < table_model_->rowCount(); ++i) {
        QString st = table_model_->item(i, 4)->text();
        if (st.contains("失败") || st.contains("拦截") || st.contains("熔断") || st.contains("跳过")) {
            table_model_->item(i, 0)->setCheckState(Qt::Checked);
            retry_items.push_back(current_items_[i]);
        } else {
            table_model_->item(i, 0)->setCheckState(Qt::Unchecked);
        }
    }

    if (retry_items.empty()) {
        QMessageBox::information(this, "提示", "当前无失败或拦截项需要重试");
        return;
    }

    engine_->set_archive_key(current_archive_key_.toStdString());
    engine_->set_items(std::move(retry_items));
    engine_->start();
}

void MainWindow::on_export_csv() {
    if (current_archive_key_.isEmpty()) {
        QMessageBox::information(this, "提示", "尚未载入任何档案数据");
        return;
    }
    QString save_path = QFileDialog::getSaveFileName(this, "导出 CSV 报表", "发送历史记录.csv", "CSV 报表 (*.csv)");
    if (!save_path.isEmpty()) {
        if (history_mgr_->export_csv(current_archive_key_.toStdString(), save_path.toStdString())) {
            QMessageBox::information(this, "成功", "历史记录已成功导出至:\n" + save_path);
        } else {
            QMessageBox::critical(this, "错误", "导出 CSV 报表失败！");
        }
    }
}

void MainWindow::append_log(const QString& msg, const QString& level) {
    QString time_str = QDateTime::currentDateTime().toString("HH:mm:ss");
    QString line = QString("[%1] [%2] %3").arg(time_str).arg(level).arg(msg);
    log_edit_->appendPlainText(line);
}

} // namespace feedback

#endif // FEEDBACK_QT_AVAILABLE
