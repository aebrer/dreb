"""
Analyze parsed Claude Code session data and generate static plots.

Reads parsed_sessions.json (from parse_sessions.py) and produces:
- Summary stats to stdout
- PNG plots in analysis/plots/
"""

import json
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

PLOTS_DIR = Path(__file__).parent / "plots"
DATA_PATH = Path(__file__).parent / "parsed_sessions.json"

# Consistent style
plt.rcParams.update({
    "figure.facecolor": "#1a1a2e",
    "axes.facecolor": "#16213e",
    "axes.edgecolor": "#e94560",
    "axes.labelcolor": "#eee",
    "text.color": "#eee",
    "xtick.color": "#ccc",
    "ytick.color": "#ccc",
    "grid.color": "#333",
    "grid.alpha": 0.5,
    "figure.figsize": (12, 6),
    "font.size": 11,
})
ACCENT = "#e94560"
ACCENT2 = "#0f3460"
ACCENT3 = "#53d8fb"
PALETTE = ["#e94560", "#53d8fb", "#0f3460", "#f5a623", "#7b68ee", "#2ecc71", "#e67e22", "#9b59b6", "#1abc9c", "#e74c3c"]


def load_data():
    with open(DATA_PATH) as f:
        return json.load(f)


def print_section(title):
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


# ---------------------------------------------------------------------------
# 1. Tool usage
# ---------------------------------------------------------------------------
def analyze_tools(main_sessions, sub_sessions):
    print_section("TOOL USAGE")

    # Aggregate across main sessions
    total_tools = Counter()
    per_project = defaultdict(Counter)
    for s in main_sessions:
        for tool, count in s["tool_frequency"].items():
            total_tools[tool] += count
            per_project[s["project"]][tool] += count

    print("\nOverall tool frequency (main sessions):")
    for tool, count in total_tools.most_common():
        print(f"  {tool:<20} {count:>6}")
    print(f"  {'TOTAL':<20} {sum(total_tools.values()):>6}")

    print("\nPer-project tool frequency:")
    for project in sorted(per_project):
        print(f"\n  {project}:")
        for tool, count in per_project[project].most_common(10):
            print(f"    {tool:<20} {count:>5}")

    # Tool chains (bigrams)
    bigrams = Counter()
    for s in main_sessions:
        seq = s["tool_sequence"]
        for i in range(len(seq) - 1):
            bigrams[(seq[i], seq[i + 1])] += 1

    print("\nTop 20 tool transitions (A -> B):")
    for (a, b), count in bigrams.most_common(20):
        print(f"  {a:<15} -> {b:<15} {count:>5}")

    # Subagent tool usage
    sub_tools = Counter()
    for s in sub_sessions:
        for tool, count in s["tool_frequency"].items():
            sub_tools[tool] += count

    if sub_tools:
        print("\nSubagent tool frequency:")
        for tool, count in sub_tools.most_common(15):
            print(f"  {tool:<20} {count:>6}")

    return total_tools, per_project, bigrams


def plot_tool_frequency(total_tools):
    """Bar chart of overall tool usage."""
    tools = [t for t, _ in total_tools.most_common()]
    counts = [c for _, c in total_tools.most_common()]

    fig, ax = plt.subplots()
    bars = ax.barh(tools[::-1], counts[::-1], color=ACCENT, edgecolor="#fff", linewidth=0.3)
    ax.set_xlabel("Total invocations")
    ax.set_title("Tool Usage Frequency (Main Sessions)")
    ax.grid(axis="x")

    for bar, count in zip(bars, counts[::-1]):
        ax.text(bar.get_width() + max(counts) * 0.01, bar.get_y() + bar.get_height() / 2,
                str(count), va="center", fontsize=9, color="#ccc")

    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "tool_frequency.png", dpi=150)
    plt.close()


def plot_tool_per_project(per_project):
    """Stacked bar chart of tool usage per project."""
    # Get top tools across all projects
    all_tools = Counter()
    for tc in per_project.values():
        all_tools.update(tc)
    top_tools = [t for t, _ in all_tools.most_common(10)]

    projects = sorted(per_project.keys())
    # Shorten project names
    short_names = [p.replace("-home-drew-projects-", "").replace("-home-drew", "home") for p in projects]

    fig, ax = plt.subplots(figsize=(14, 7))
    bottom = [0] * len(projects)
    for i, tool in enumerate(top_tools):
        values = [per_project[p].get(tool, 0) for p in projects]
        ax.bar(short_names, values, bottom=bottom, label=tool, color=PALETTE[i % len(PALETTE)],
               edgecolor="#fff", linewidth=0.3)
        bottom = [b + v for b, v in zip(bottom, values)]

    ax.set_ylabel("Tool invocations")
    ax.set_title("Tool Usage by Project")
    ax.legend(loc="upper right", fontsize=8)
    ax.grid(axis="y")
    plt.xticks(rotation=30, ha="right")
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "tool_per_project.png", dpi=150)
    plt.close()


def plot_tool_transitions(bigrams):
    """Heatmap of tool transition frequencies."""
    # Get top tools by total involvement in transitions
    tool_counts = Counter()
    for (a, b), count in bigrams.items():
        tool_counts[a] += count
        tool_counts[b] += count
    top = [t for t, _ in tool_counts.most_common(10)]

    matrix = []
    for a in top:
        row = []
        for b in top:
            row.append(bigrams.get((a, b), 0))
        matrix.append(row)

    fig, ax = plt.subplots(figsize=(10, 8))
    im = ax.imshow(matrix, cmap="YlOrRd", aspect="auto")
    ax.set_xticks(range(len(top)))
    ax.set_yticks(range(len(top)))
    ax.set_xticklabels(top, rotation=45, ha="right", fontsize=9)
    ax.set_yticklabels(top, fontsize=9)
    ax.set_xlabel("Next tool")
    ax.set_ylabel("Previous tool")
    ax.set_title("Tool Transition Heatmap (A → B)")

    # Annotate cells
    for i in range(len(top)):
        for j in range(len(top)):
            val = matrix[i][j]
            if val > 0:
                color = "#000" if val > max(max(r) for r in matrix) * 0.6 else "#fff"
                ax.text(j, i, str(val), ha="center", va="center", fontsize=8, color=color)

    plt.colorbar(im, ax=ax, shrink=0.8)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "tool_transitions.png", dpi=150)
    plt.close()


# ---------------------------------------------------------------------------
# 2. Session patterns
# ---------------------------------------------------------------------------
def analyze_sessions(main_sessions):
    print_section("SESSION PATTERNS")

    total = len(main_sessions)
    tg = [s for s in main_sessions if s["is_telegram"]]
    cli = [s for s in main_sessions if not s["is_telegram"]]

    print(f"\nTotal main sessions: {total}")
    print(f"  Telegram: {len(tg)} ({100*len(tg)/total:.0f}%)")
    print(f"  CLI:      {len(cli)} ({100*len(cli)/total:.0f}%)")

    # Session lengths (message count)
    msg_counts = [s["total_messages"] for s in main_sessions]
    print(f"\nSession length (messages):")
    print(f"  Mean:   {sum(msg_counts)/len(msg_counts):.1f}")
    print(f"  Median: {sorted(msg_counts)[len(msg_counts)//2]}")
    print(f"  Max:    {max(msg_counts)}")
    print(f"  Min:    {min(msg_counts)}")

    # Duration
    durations = [s["duration_seconds"] for s in main_sessions if s["duration_seconds"] is not None]
    if durations:
        print(f"\nSession duration (minutes):")
        dur_min = [d / 60 for d in durations]
        print(f"  Mean:   {sum(dur_min)/len(dur_min):.1f}")
        print(f"  Median: {sorted(dur_min)[len(dur_min)//2]:.1f}")
        print(f"  Max:    {max(dur_min):.1f}")

    # Telegram vs CLI comparison
    for label, subset in [("Telegram", tg), ("CLI", cli)]:
        if not subset:
            continue
        mc = [s["total_messages"] for s in subset]
        tc = [sum(s["tool_frequency"].values()) for s in subset]
        print(f"\n  {label}:")
        print(f"    Avg messages/session:    {sum(mc)/len(mc):.1f}")
        print(f"    Avg tool calls/session:  {sum(tc)/len(tc):.1f}")

    # Per-project session counts
    proj_counts = Counter(s["project"] for s in main_sessions)
    print("\nSessions per project:")
    for proj, count in proj_counts.most_common():
        print(f"  {proj:<40} {count:>4}")

    return main_sessions


def plot_session_lengths(main_sessions):
    """Histogram of session lengths."""
    msg_counts = [s["total_messages"] for s in main_sessions]

    fig, ax = plt.subplots()
    ax.hist(msg_counts, bins=30, color=ACCENT, edgecolor="#fff", linewidth=0.5)
    ax.set_xlabel("Messages per session")
    ax.set_ylabel("Count")
    ax.set_title("Session Length Distribution")
    ax.grid(axis="y")
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "session_lengths.png", dpi=150)
    plt.close()


def plot_telegram_vs_cli(main_sessions):
    """Compare Telegram vs CLI sessions."""
    tg = [s for s in main_sessions if s["is_telegram"]]
    cli = [s for s in main_sessions if not s["is_telegram"]]

    # Tool usage comparison
    tg_tools = Counter()
    cli_tools = Counter()
    for s in tg:
        tg_tools.update(s["tool_frequency"])
    for s in cli:
        cli_tools.update(s["tool_frequency"])

    # Normalize by session count
    all_tools_set = sorted(set(list(tg_tools.keys()) + list(cli_tools.keys())),
                           key=lambda t: -(tg_tools.get(t, 0) + cli_tools.get(t, 0)))[:12]

    tg_norm = [tg_tools.get(t, 0) / max(len(tg), 1) for t in all_tools_set]
    cli_norm = [cli_tools.get(t, 0) / max(len(cli), 1) for t in all_tools_set]

    fig, ax = plt.subplots(figsize=(14, 6))
    x = range(len(all_tools_set))
    w = 0.35
    ax.bar([i - w/2 for i in x], tg_norm, w, label=f"Telegram (n={len(tg)})", color=ACCENT, edgecolor="#fff", linewidth=0.3)
    ax.bar([i + w/2 for i in x], cli_norm, w, label=f"CLI (n={len(cli)})", color=ACCENT3, edgecolor="#fff", linewidth=0.3)
    ax.set_xticks(list(x))
    ax.set_xticklabels(all_tools_set, rotation=30, ha="right")
    ax.set_ylabel("Avg calls per session")
    ax.set_title("Tool Usage: Telegram vs CLI")
    ax.legend()
    ax.grid(axis="y")
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "telegram_vs_cli.png", dpi=150)
    plt.close()


def plot_activity_timeline(main_sessions):
    """Session activity over time."""
    times = []
    for s in main_sessions:
        if s["start_time"]:
            try:
                times.append(datetime.fromisoformat(s["start_time"]))
            except ValueError:
                pass

    if not times:
        return

    # Group by date
    date_counts = Counter(t.date() for t in times)
    dates = sorted(date_counts.keys())
    counts = [date_counts[d] for d in dates]

    fig, ax = plt.subplots(figsize=(14, 5))
    ax.bar(dates, counts, color=ACCENT, edgecolor="#fff", linewidth=0.3, width=1)
    ax.set_xlabel("Date")
    ax.set_ylabel("Sessions")
    ax.set_title("Session Activity Over Time")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    ax.xaxis.set_major_locator(mdates.WeekdayLocator(interval=1))
    plt.xticks(rotation=45, ha="right")
    ax.grid(axis="y")
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "activity_timeline.png", dpi=150)
    plt.close()


def plot_hour_of_day(main_sessions):
    """When do sessions happen?"""
    hours = []
    for s in main_sessions:
        if s["start_time"]:
            try:
                t = datetime.fromisoformat(s["start_time"])
                hours.append(t.hour)
            except ValueError:
                pass

    if not hours:
        return

    hour_counts = Counter(hours)
    hrs = range(24)
    counts = [hour_counts.get(h, 0) for h in hrs]

    fig, ax = plt.subplots(figsize=(10, 5))
    ax.bar(hrs, counts, color=ACCENT, edgecolor="#fff", linewidth=0.3)
    ax.set_xlabel("Hour (UTC)")
    ax.set_ylabel("Sessions")
    ax.set_title("Sessions by Hour of Day")
    ax.set_xticks(list(hrs))
    ax.grid(axis="y")
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "hour_of_day.png", dpi=150)
    plt.close()


# ---------------------------------------------------------------------------
# 3. Feature usage
# ---------------------------------------------------------------------------
def analyze_features(main_sessions, sub_sessions):
    print_section("FEATURE USAGE")

    # Subagent stats
    all_spawns = []
    for s in main_sessions:
        all_spawns.extend(s["subagent_spawns"])

    subagent_types = Counter(sp["type"] for sp in all_spawns)
    print(f"\nSubagent spawns: {len(all_spawns)} total across {sum(1 for s in main_sessions if s['subagent_spawns'])} sessions")
    if subagent_types:
        print("  By type:")
        for t, c in subagent_types.most_common():
            print(f"    {t:<30} {c:>4}")

    # Skills
    all_skills = []
    for s in main_sessions:
        all_skills.extend(s["skill_invocations"])
    skill_counts = Counter(all_skills)
    print(f"\nSkill invocations: {len(all_skills)} total")
    if skill_counts:
        for sk, c in skill_counts.most_common():
            print(f"  {sk:<30} {c:>4}")

    # Thinking blocks
    sessions_with_thinking = [s for s in main_sessions if s["thinking_count"] > 0]
    total_thinking = sum(s["thinking_count"] for s in main_sessions)
    total_thinking_chars = sum(s["thinking_chars"] for s in main_sessions)
    print(f"\nThinking blocks: {total_thinking} across {len(sessions_with_thinking)} sessions")
    if total_thinking > 0:
        print(f"  Avg chars/block: {total_thinking_chars / total_thinking:.0f}")

    # Models
    all_models = Counter()
    for s in main_sessions:
        for m in s["models"]:
            all_models[m] += 1
    print(f"\nModels seen:")
    for m, c in all_models.most_common():
        print(f"  {m:<40} {c:>4} sessions")

    # Versions
    versions = Counter(s["version"] for s in main_sessions if s["version"])
    print(f"\nClaude Code versions:")
    for v, c in versions.most_common(10):
        print(f"  {v:<20} {c:>4} sessions")

    return subagent_types, skill_counts


def plot_subagent_types(subagent_types):
    """Pie chart of subagent types."""
    if not subagent_types:
        return

    labels = list(subagent_types.keys())
    sizes = list(subagent_types.values())

    fig, ax = plt.subplots(figsize=(8, 8))
    wedges, texts, autotexts = ax.pie(sizes, labels=labels, autopct="%1.0f%%",
                                       colors=PALETTE[:len(labels)],
                                       textprops={"color": "#eee", "fontsize": 9})
    ax.set_title("Subagent Types Spawned")
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "subagent_types.png", dpi=150)
    plt.close()


# ---------------------------------------------------------------------------
# 4. Content patterns
# ---------------------------------------------------------------------------
def analyze_content(main_sessions):
    print_section("CONTENT PATTERNS")

    user_lengths = []
    assistant_lengths = []
    tool_vs_text = {"tool_calls": 0, "text_blocks": 0}

    for s in main_sessions:
        user_lengths.extend(s["user_message_lengths"])
        assistant_lengths.extend(s["assistant_message_lengths"])
        tool_vs_text["tool_calls"] += sum(s["tool_frequency"].values())
        tool_vs_text["text_blocks"] += s["assistant_text_blocks"]

    if user_lengths:
        print(f"\nUser message length (chars):")
        print(f"  Mean:   {sum(user_lengths)/len(user_lengths):.0f}")
        print(f"  Median: {sorted(user_lengths)[len(user_lengths)//2]}")

    if assistant_lengths:
        print(f"\nAssistant text block length (chars):")
        print(f"  Mean:   {sum(assistant_lengths)/len(assistant_lengths):.0f}")
        print(f"  Median: {sorted(assistant_lengths)[len(assistant_lengths)//2]}")

    print(f"\nTool calls vs text blocks:")
    print(f"  Tool calls:  {tool_vs_text['tool_calls']}")
    print(f"  Text blocks: {tool_vs_text['text_blocks']}")
    ratio = tool_vs_text["tool_calls"] / max(tool_vs_text["text_blocks"], 1)
    print(f"  Ratio:       {ratio:.2f} tool calls per text block")

    # Sessions with high tool density
    tool_densities = []
    for s in main_sessions:
        tc = sum(s["tool_frequency"].values())
        msgs = s["total_messages"]
        if msgs > 0:
            tool_densities.append(tc / msgs)

    if tool_densities:
        print(f"\nTool density (tool calls per message):")
        print(f"  Mean:   {sum(tool_densities)/len(tool_densities):.2f}")
        print(f"  Median: {sorted(tool_densities)[len(tool_densities)//2]:.2f}")


def plot_message_lengths(main_sessions):
    """Histogram of user vs assistant message lengths."""
    user_lengths = []
    assistant_lengths = []
    for s in main_sessions:
        user_lengths.extend(s["user_message_lengths"])
        assistant_lengths.extend(s["assistant_message_lengths"])

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

    if user_lengths:
        # Cap at 95th percentile for readability
        cap = sorted(user_lengths)[int(len(user_lengths) * 0.95)]
        ax1.hist([min(l, cap) for l in user_lengths], bins=30, color=ACCENT3, edgecolor="#fff", linewidth=0.3)
        ax1.set_xlabel("Characters")
        ax1.set_ylabel("Count")
        ax1.set_title("User Message Lengths")
        ax1.grid(axis="y")

    if assistant_lengths:
        cap = sorted(assistant_lengths)[int(len(assistant_lengths) * 0.95)]
        ax2.hist([min(l, cap) for l in assistant_lengths], bins=30, color=ACCENT, edgecolor="#fff", linewidth=0.3)
        ax2.set_xlabel("Characters")
        ax2.set_ylabel("Count")
        ax2.set_title("Assistant Text Block Lengths")
        ax2.grid(axis="y")

    plt.suptitle("Message Length Distributions (95th percentile cap)")
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "message_lengths.png", dpi=150)
    plt.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    PLOTS_DIR.mkdir(exist_ok=True)

    data = load_data()
    main_sessions = data["main_sessions"]
    sub_sessions = data["subagent_sessions"]

    print(f"Loaded {len(main_sessions)} main + {len(sub_sessions)} subagent sessions")
    print(f"Generated: {data['generated_at']}")

    # Analysis + stdout summary
    total_tools, per_project, bigrams = analyze_tools(main_sessions, sub_sessions)
    analyze_sessions(main_sessions)
    subagent_types, skill_counts = analyze_features(main_sessions, sub_sessions)
    analyze_content(main_sessions)

    # Plots
    print(f"\nGenerating plots in {PLOTS_DIR}/ ...", file=sys.stderr)
    plot_tool_frequency(total_tools)
    plot_tool_per_project(per_project)
    plot_tool_transitions(bigrams)
    plot_session_lengths(main_sessions)
    plot_telegram_vs_cli(main_sessions)
    plot_activity_timeline(main_sessions)
    plot_hour_of_day(main_sessions)
    plot_subagent_types(subagent_types)
    plot_message_lengths(main_sessions)

    print(f"Done! {len(list(PLOTS_DIR.glob('*.png')))} plots generated.", file=sys.stderr)


if __name__ == "__main__":
    main()
