import { describe, expect, it } from "vitest";
import { buildPtyEnv } from "../src/main/pty-env";

describe("buildPtyEnv", () => {
  it("strips inherited terminal emulator markers", () => {
    const base: NodeJS.ProcessEnv = {
      TERM_PROGRAM: "ghostty",
      TMUX: "/tmp/x,1,0",
      GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
      ITERM_SESSION_ID: "abc123",
      PATH: "/usr/bin:/bin",
      HOME: "/Users/user",
    };
    const env = buildPtyEnv(base, undefined, { appVersion: "1.0.0" });
    expect(env.TERM_PROGRAM).toBe("harbormaster");
    expect(env.TMUX).toBeUndefined();
    expect(env.GHOSTTY_RESOURCES_DIR).toBeUndefined();
    expect(env.ITERM_SESSION_ID).toBeUndefined();
  });

  it("strips the identity of an agent session the app was started from", () => {
    const env = buildPtyEnv(
      {
        PI_SESSION_ID: "outer",
        PI_SUBAGENT_CHILD: "1",
        CLAUDECODE: "1",
        PATH: "/bin",
      },
      { HARBORMASTER_TASK_ID: "t1" },
      { appVersion: "1" },
    );
    expect(env.PI_SESSION_ID).toBeUndefined();
    expect(env.PI_SUBAGENT_CHILD).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.HARBORMASTER_TASK_ID).toBe("t1");
  });

  it("sets COLORTERM=truecolor", () => {
    const env = buildPtyEnv({}, undefined, { appVersion: "1.0.0" });
    expect(env.COLORTERM).toBe("truecolor");
  });

  it("sets TERM_PROGRAM=harbormaster and TERM_PROGRAM_VERSION", () => {
    const env = buildPtyEnv({}, undefined, { appVersion: "2.3.4" });
    expect(env.TERM_PROGRAM).toBe("harbormaster");
    expect(env.TERM_PROGRAM_VERSION).toBe("2.3.4");
  });

  it("sets LANG to en_US.UTF-8 when absent", () => {
    const env = buildPtyEnv({}, undefined, { appVersion: "1.0.0" });
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("keeps LANG when it is already UTF-8", () => {
    const env = buildPtyEnv({ LANG: "de_DE.UTF-8" }, undefined, {
      appVersion: "1.0.0",
    });
    expect(env.LANG).toBe("de_DE.UTF-8");
  });

  it("overwrites non-UTF-8 LANG with en_US.UTF-8", () => {
    const env = buildPtyEnv({ LANG: "en_US" }, undefined, {
      appVersion: "1.0.0",
    });
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("overlay wins over everything", () => {
    const env = buildPtyEnv(
      { COLORTERM: "256" },
      { COLORTERM: "override", MY_VAR: "hello" },
      { appVersion: "1.0.0" },
    );
    expect(env.COLORTERM).toBe("override");
    expect(env.MY_VAR).toBe("hello");
  });

  it("sets PI_HYPERLINKS=1 when hyperlinks option is true", () => {
    const env = buildPtyEnv({}, undefined, {
      appVersion: "1.0.0",
      hyperlinks: true,
    });
    expect(env.PI_HYPERLINKS).toBe("1");
  });

  it("does not set PI_HYPERLINKS when hyperlinks option is false", () => {
    const env = buildPtyEnv({}, undefined, {
      appVersion: "1.0.0",
      hyperlinks: false,
    });
    expect(env.PI_HYPERLINKS).toBeUndefined();
  });

  it("does not mutate the base env", () => {
    const base: NodeJS.ProcessEnv = { TERM_PROGRAM: "ghostty" };
    buildPtyEnv(base, undefined, { appVersion: "1.0.0" });
    expect(base.TERM_PROGRAM).toBe("ghostty");
  });
});
