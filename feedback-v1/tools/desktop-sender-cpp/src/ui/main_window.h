#pragma once

#ifdef FEEDBACK_QT_AVAILABLE

#include <QMainWindow>
#include <QTableView>
#include <QStandardItemModel>
#include <QTextBrowser>
#include <QPlainTextEdit>
#include <QProgressBar>
#include <QPushButton>
#include <QComboBox>
#include <QLabel>
#include <memory>
#include "../engine/sender_engine.h"
#include "../history_manager.h"

namespace feedback {

class MainWindow : public QMainWindow {
    Q_OBJECT

public:
    explicit MainWindow(QWidget* parent = nullptr);
    ~MainWindow() override;

private slots:
    void on_open_file();
    void on_export_csv();
    void on_cycle_changed(const QString& cycle);
    void on_table_selection_changed(const QItemSelection& selected, const QItemSelection& deselected);
    void on_start_clicked();
    void on_pause_clicked();
    void on_resume_clicked();
    void on_stop_clicked();
    void on_retry_failed_clicked();

private:
    void setup_ui();
    void load_file(const QString& path);
    void update_table_view();
    void append_log(const QString& msg, const QString& level);

    std::shared_ptr<IAutomationDriver> driver_;
    std::shared_ptr<HistoryManager> history_mgr_;
    std::unique_ptr<SenderEngine> engine_;

    std::vector<FeedbackItem> current_items_;
    QString current_file_path_;
    QString current_archive_key_;

    // UI Widgets
    QComboBox* cycle_combo_ = nullptr;
    QLabel* file_label_ = nullptr;
    QTableView* table_view_ = nullptr;
    QStandardItemModel* table_model_ = nullptr;
    QTextBrowser* preview_browser_ = nullptr;
    QPlainTextEdit* log_edit_ = nullptr;
    QProgressBar* progress_bar_ = nullptr;
    QLabel* status_label_ = nullptr;

    QPushButton* btn_start_ = nullptr;
    QPushButton* btn_pause_ = nullptr;
    QPushButton* btn_resume_ = nullptr;
    QPushButton* btn_stop_ = nullptr;
    QPushButton* btn_retry_ = nullptr;
};

} // namespace feedback

#endif // FEEDBACK_QT_AVAILABLE
