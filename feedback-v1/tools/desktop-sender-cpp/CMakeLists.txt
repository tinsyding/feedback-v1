cmake_minimum_required(VERSION 3.16)
project(JiFangFeedbackCpp VERSION 2.4.2 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 包含路径
include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# 核心通用库源文件
set(CORE_SOURCES
    src/parser.cpp
    src/image_proc.cpp
    src/history_manager.cpp
    src/engine/sender_engine.cpp
    src/automation/win32_driver.cpp
)

add_library(jifang_core STATIC ${CORE_SOURCES})

# 检查 Qt6 环境
find_package(Qt6 COMPONENTS Core Gui Widgets Network QUIET)

if(Qt6_FOUND)
    message(STATUS "=== 检测到 Qt6，启用 Qt 原生桌面 GUI 客户端构建 ===")
    set(CMAKE_AUTOMOC ON)
    set(CMAKE_AUTORCC ON)
    set(CMAKE_AUTOUIC ON)

    target_compile_definitions(jifang_core PUBLIC FEEDBACK_QT_AVAILABLE)

    set(GUI_SOURCES
        src/main.cpp
        src/ui/main_window.cpp
    )

    if(WIN32)
        # Windows 图标与版本资源文件
        set(RES_FILES assets/app.ico version.rc)
        add_executable(desktop-sender-cpp WIN32 ${GUI_SOURCES} ${RES_FILES})
    else()
        add_executable(desktop-sender-cpp ${GUI_SOURCES})
    endif()

    target_link_libraries(desktop-sender-cpp PRIVATE
        jifang_core
        Qt6::Core
        Qt6::Gui
        Qt6::Widgets
        Qt6::Network
    )
else()
    message(STATUS "=== 未检测到 Qt6（无界面/诊断模式），构建原生 CLI 诊断工具 ===")
    add_executable(desktop-sender-cpp src/main.cpp)
    target_link_libraries(desktop-sender-cpp PRIVATE jifang_core)
endif()

# 单元测试套件
enable_testing()
add_executable(run_unit_tests tests/test_parser.cpp)
target_link_libraries(run_unit_tests PRIVATE jifang_core)
add_test(NAME CoreLogicTests COMMAND run_unit_tests)
