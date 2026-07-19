import { describe, expect, it } from "vitest";
import { CommandCenterService, extractOpenTasks } from "../src/services/commandCenterService";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";

describe("CommandCenterService task extraction", () => {
  it("collects open tasks and assigns mobile dashboard due states", () => {
    const tasks = extractOpenTasks("Projects/Launch.md", [
      "- [ ] Overdue item 📅 2026-07-18",
      "- [x] Completed item 📅 2026-07-17",
      "- [ ] Due today due:: 2026-07-19",
      "- [ ] Unscheduled item"
    ].join("\n"), new Date("2026-07-19T12:00:00"));

    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ path: "Projects/Launch.md", line: 0, due: "2026-07-18", overdue: true });
    expect(tasks[1]).toMatchObject({ line: 2, due: "2026-07-19", overdue: false });
    expect(tasks[2]).toMatchObject({ line: 3, overdue: false });
  });

  it("ignores task-looking examples inside fenced code blocks", () => {
    const tasks = extractOpenTasks("Templates/Task.md", [
      "```markdown",
      "- [ ] Example only",
      "```",
      "- [ ] Real task"
    ].join("\n"), new Date("2026-07-19T12:00:00"));

    expect(tasks.map((task) => task.text)).toEqual(["Real task"]);
  });

  it("keeps memory and conversation files out of the productivity dashboard", async () => {
    const files = [
      { path: "conversations/Old chat.md", basename: "Old chat", stat: { mtime: 400 } },
      { path: "memory/preferences.md", basename: "preferences", stat: { mtime: 300 } },
      { path: "Classes/Lesson.md", basename: "Lesson", stat: { mtime: 200 } }
    ];
    const app = {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: async (file: { path: string }) => file.path === "Classes/Lesson.md" ? "- [ ] Review lesson" : ""
      },
      metadataCache: {
        getFileCache: (file: { path: string }) => file.path === "Classes/Lesson.md"
          ? { listItems: [{ task: " ", position: { start: { line: 0 } } }] }
          : {}
      }
    };
    const service = new CommandCenterService(
      app as never,
      () => ({ ...DEFAULT_SETTINGS, memoryFolder: "memory", conversationsFolder: "conversations" })
    );

    const snapshot = await service.snapshot();

    expect(snapshot.recentNotes.map((note) => note.path)).toEqual(["Classes/Lesson.md"]);
    expect(snapshot.briefing[0]).toBe("1 priority task is ready for review.");
  });
});
