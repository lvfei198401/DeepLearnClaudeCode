"""扫描 restored-src/src 目录，统计各类源码文件的行数。"""

import os
from collections import defaultdict
from pathlib import Path

SRC_DIR = Path(__file__).parent / "restored-src" / "src"


def count_lines(root: Path):
    stats = defaultdict(lambda: {"files": 0, "lines": 0})
    total_files = 0
    total_lines = 0

    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            filepath = Path(dirpath) / name
            ext = filepath.suffix.lower() or "(no ext)"
            try:
                lines = filepath.read_text(encoding="utf-8", errors="ignore").count("\n")
            except OSError:
                continue
            stats[ext]["files"] += 1
            stats[ext]["lines"] += lines
            total_files += 1
            total_lines += lines

    # 按行数降序排列
    sorted_stats = sorted(stats.items(), key=lambda x: x[1]["lines"], reverse=True)

    print(f"{'扩展名':<12} {'文件数':>8} {'代码行数':>12}")
    print("-" * 36)
    for ext, info in sorted_stats:
        print(f"{ext:<12} {info['files']:>8,} {info['lines']:>12,}")
    print("-" * 36)
    print(f"{'合计':<12} {total_files:>8,} {total_lines:>12,}")


if __name__ == "__main__":
    if not SRC_DIR.is_dir():
        print(f"目录不存在: {SRC_DIR}")
        raise SystemExit(1)
    count_lines(SRC_DIR)
