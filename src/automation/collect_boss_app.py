#!/usr/bin/env python3
"""BOSS直聘 App 端采集脚本（Android 模拟器 + uiautomator2）

用法：
  python collect_boss_app.py --keyword "测试工程师" --city "杭州" --target 20

输出：JSON 数组到 stdout
"""

import json
import sys
import time
import argparse
import os
import subprocess
import re

try:
    import uiautomator2 as u2
except ImportError:
    print(json.dumps({"error": "uiautomator2 未安装，请先执行: pip install uiautomator2"}))
    sys.exit(1)


BOSS_PACKAGE = "com.hpbr.bosszhipin"
AVD_NAME = "boss_android"
ANDROID_HOME = os.environ.get("ANDROID_HOME", os.path.expanduser("~/Library/Android/sdk"))
EMULATOR = os.path.join(ANDROID_HOME, "emulator", "emulator")
ADB = os.path.join(ANDROID_HOME, "platform-tools", "adb")


def log(msg):
    print(f"[collect_app] {msg}", file=sys.stderr)


def ensure_emulator_running():
    """确保模拟器已启动"""
    # 检查 adb 设备列表
    result = subprocess.run([ADB, "devices"], capture_output=True, text=True)
    if "emulator" in result.stdout:
        log("模拟器已连接")
        return True

    log("启动模拟器...")
    subprocess.Popen(
        [EMULATOR, "-avd", AVD_NAME, "-no-boot-anim", "-netdelay", "none", "-netspeed", "full"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # 等待模拟器启动（最多等待 120 秒）
    for _ in range(60):
        time.sleep(2)
        result = subprocess.run([ADB, "devices"], capture_output=True, text=True)
        lines = [l for l in result.stdout.strip().split("\n") if l]
        for line in lines[1:]:
            if "\tdevice" in line:
                log("模拟器启动完成")
                # 再等几秒让系统稳定
                time.sleep(10)
                return True
        log("等待模拟器启动...")

    log("模拟器启动超时")
    return False


def ensure_app_installed(d):
    """安装 BOSS APK（如未安装）"""
    info = d.app_info(BOSS_PACKAGE)
    if info:
        log(f"BOSS 已安装: {info.get('versionName', 'unknown')}")
        return True

    apk_path = os.environ.get("BOSS_APK", "/tmp/boss.apk")
    if not os.path.exists(apk_path):
        log(f"APK 不存在: {apk_path}")
        return False

    log(f"安装 BOSS APK: {apk_path}")
    d.app_install(apk_path)
    time.sleep(3)
    info = d.app_info(BOSS_PACKAGE)
    if info:
        log("安装完成")
        return True
    log("安装失败")
    return False


def wait_for_login(d, timeout=120):
    """等待用户在 App 中完成登录"""
    log("检查登录状态...")
    deadline = time.time() + timeout

    # BOSS 的已登录特征：主页面有"职位"或"消息"等底部 tab
    login_indicators = [
        '职位', '消息', '我的', '推荐', '附近',
        'job', 'message', 'mine', 'recommend'
    ]

    while time.time() < deadline:
        try:
            xml = d.dump_hierarchy()
            for indicator in login_indicators:
                if indicator in xml:
                    log("检测到已登录")
                    return True
        except Exception:
            pass

        # 检查是否在登录页
        if "登录" in d.dump_hierarchy() or "手机号" in d.dump_hierarchy():
            log("等待用户在模拟器中完成登录（扫码或手机号登录）...")
        else:
            log("等待页面加载...")

        time.sleep(3)

    log("登录等待超时")
    return False


def navigate_to_jobs(d):
    """导航到职位推荐页面（App 首页推荐流）"""
    log("导航到职位推荐...")

    # BOSS App 首页就是推荐流，尝试点击底部"职位"tab
    tabs_to_try = [
        ('职位', 'text'),
        ('job', 'text'),
        ('推荐', 'text'),
        ('recommend', 'text'),
    ]

    for text, attr in tabs_to_try:
        try:
            el = d.xpath(f'//*[@{attr}="{text}"]')
            if el.exists:
                el.click()
                time.sleep(2)
                log(f"已点击 '{text}' tab")
                return True
        except Exception:
            continue

    # 资源 ID 兜底
    resource_tabs = [
        'com.hpbr.bosszhipin:id/tab_job',
        'com.hpbr.bosszhipin:id/tab_home',
        'com.hpbr.bosszhipin:id/rb_job',
        'com.hpbr.bosszhipin:id/tv_job',
    ]

    for rid in resource_tabs:
        try:
            el = d(resourceId=rid)
            if el.exists:
                el.click()
                time.sleep(2)
                log(f"已点击资源 '{rid}'")
                return True
        except Exception:
            continue

    # 实在找不到，按坐标点底部中间（通常是"职位"tab）
    w, h = d.window_size()
    d.click(w // 2, h - 60)
    time.sleep(2)
    return True


def extract_job_cards(d):
    """从当前页面提取职位卡片信息"""
    cards = []

    xml = d.dump_hierarchy()

    # 尝试多种匹配方式提取职位卡片
    # BOSS App 的职位卡片通常包含：职位名、公司名、薪资、城市、经验等

    # 方法1：通过包含薪资特征的容器查找
    salary_pattern = re.compile(r'\d+[kK千]-?\d*[kK千]?')
    # 方法2：通过常见的 resource-id 模式
    # 方法3：通过 class 层次提取

    # 提取所有可见文本节点
    try:
        elements = d.xpath('//android.widget.TextView').all()
        texts = []
        for el in elements:
            try:
                t = el.text.strip()
                if t:
                    texts.append(t)
            except Exception:
                pass

        # 尝试从文本列表中解析出职位信息
        # BOSS 卡片文本顺序通常是: 职位名 | 公司 | 城市·经验·学历 | 薪资 | 公司类型 | HR 活跃
        i = 0
        while i < len(texts):
            t = texts[i]
            # 检测薪资特征: "15-25K", "15k-25k"
            if salary_pattern.match(t) or (t.endswith('K') or t.endswith('k')):
                salary = t
                title = texts[i - 1] if i >= 1 else ""
                company = texts[i - 2] if i >= 2 else ""
                city_exp = texts[i + 1] if i + 1 < len(texts) else ""

                # 去除非职位文本
                if title and company and not any(
                    skip in title for skip in ['登录', '注册', '消息', '我的', '推荐', '职位']
                ):
                    cards.append({
                        "title": title,
                        "company": company,
                        "salary": salary,
                        "city": city_exp,
                    })
            i += 1
    except Exception as e:
        log(f"文本提取失败: {e}")

    return cards


def collect_jobs(d, keyword, city, target=20):
    """滚动并采集职位，直到达到目标数量或没有新数据"""
    all_cards = []
    seen = set()
    no_new_streak = 0
    max_scrolls = 50

    for scroll in range(max_scrolls):
        if len(all_cards) >= target:
            break

        cards = extract_job_cards(d)
        new_count = 0
        for card in cards:
            key = f"{card.get('title','')}|{card.get('company','')}"
            if key not in seen:
                seen.add(key)
                all_cards.append(card)
                new_count += 1

        log(f"滚动 {scroll+1}: 已采集 {len(all_cards)} 个职位（新增 {new_count}）")

        if new_count == 0:
            no_new_streak += 1
            if no_new_streak >= 5:
                log("连续无新数据，停止滚动")
                break
        else:
            no_new_streak = 0

        # 向上滑动
        w, h = d.window_size()
        d.swipe(w // 2, h * 3 // 4, w // 2, h // 4, duration=0.5)
        time.sleep(1.5)

    return all_cards


def main():
    parser = argparse.ArgumentParser(description="BOSS直聘 App 端采集")
    parser.add_argument("--keyword", default="测试工程师", help="搜索关键词")
    parser.add_argument("--city", default="杭州", help="城市")
    parser.add_argument("--target", type=int, default=20, help="采集目标数")
    parser.add_argument("--skip-emulator-check", action="store_true", help="跳过模拟器启动检查")
    args = parser.parse_args()

    if not args.skip_emulator_check:
        if not ensure_emulator_running():
            print(json.dumps({"error": "模拟器启动失败"}))
            sys.exit(1)

    # 连接设备
    d = u2.connect()
    log(f"设备信息: {d.info}")

    # 确保 App 已安装
    if not ensure_app_installed(d):
        print(json.dumps({"error": "BOSS APK 安装失败"}))
        sys.exit(1)

    # 启动 App
    d.app_start(BOSS_PACKAGE)
    time.sleep(5)

    # 等待登录
    if not wait_for_login(d):
        print(json.dumps({"error": "等待登录超时，请在模拟器中手动登录 BOSS App"}))
        sys.exit(1)

    # 导航到职位页
    navigate_to_jobs(d)
    time.sleep(3)

    # 如果指定了关键词，在 App 内搜索
    if args.keyword:
        log(f"搜索: {args.keyword} {args.city}")
        try:
            # 点击搜索按钮
            search_btn = d.xpath('//*[contains(@text, "搜索") or contains(@content-desc, "搜索")]')
            if search_btn.exists:
                search_btn.click()
                time.sleep(1)

            # 输入关键词
            search_input = d.xpath('//*[@class="android.widget.EditText"]')
            if search_input.exists:
                search_input.set_text(f"{args.keyword} {args.city}")
                time.sleep(0.5)
                d.press("enter")
                time.sleep(3)
            else:
                log("未找到搜索输入框，使用首页推荐流")
        except Exception as e:
            log(f"搜索操作失败: {e}，使用首页推荐流")

    # 切换排序为「最新」
    try:
        sort_el = d.xpath('//*[contains(@text, "最新") or contains(@text, "排序")]')
        if sort_el.exists:
            sort_el.click()
            time.sleep(1)
            newest = d.xpath('//*[contains(@text, "最新发布") or contains(@text, "最新")]')
            if newest.exists:
                newest.click()
                time.sleep(2)
    except Exception:
        pass

    # 开始采集
    log(f"开始采集... 目标: {args.target}")
    cards = collect_jobs(d, args.keyword, args.city, args.target)

    log(f"采集完成，共 {len(cards)} 个职位")

    # 输出 JSON 结果
    result = []
    for i, card in enumerate(cards):
        result.append({
            "sourceId": f"boss-app-{i}-{int(time.time())}",
            "title": card.get("title", ""),
            "company": card.get("company", ""),
            "salary": card.get("salary", ""),
            "city": card.get("city", ""),
            "experience": card.get("experience", ""),
            "reason": f"App端采集: {args.keyword} - {args.city}",
            "raw": card,
        })

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
