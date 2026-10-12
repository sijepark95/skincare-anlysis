import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  assertOwnedContainer,
  engineSocket,
  hasLoopbackPorts,
  replacementConfig,
  runtimeArchivePaths,
  rewriteLoopbackPorts,
} from "../scripts/supabase-local-start.mjs";

const root = path.resolve("test-workspace");
function container() {
  return {
    Id: "original-container",
    Image: "sha256:original-image-id",
    Name: "/supabase_db_senmiva",
    Config: {
      Image: "original-image-tag",
      Env: ["DATABASE_SECRET=private-test-value"],
      Labels: {
        "com.supabase.cli.project": "senmiva",
        "com.docker.compose.project": "senmiva",
        "com.supabase.cli.workdir": root,
        "desktop.docker.io/ports/5432/tcp": ":15432",
      },
    },
    HostConfig: {
      PortBindings: {
        "5432/tcp": [
          { HostIp: "0.0.0.0", HostPort: "15432" },
          { HostIp: "::", HostPort: "15432" },
        ],
      } as Record<string, { HostIp: string; HostPort: string }[]>,
      Binds: ["supabase_db_senmiva:/var/lib/postgresql/data:z"],
      NetworkMode: "senmiva-local",
      Privileged: false,
      AutoRemove: false,
    },
    Mounts: [
      {
        Type: "volume",
        Name: "supabase_db_senmiva",
        Destination: "/var/lib/postgresql/data",
        RW: true,
      },
    ],
    NetworkSettings: {
      Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "15432" }] },
      Networks: {
        "senmiva-local": {
          Aliases: ["supabase_db_senmiva"],
          IPAddress: "172.20.0.2",
          IPAMConfig: null,
          Links: null,
          DriverOpts: null,
        },
      },
    },
  };
}

describe("local Docker container ownership boundary", () => {
  it("accepts only the expected project database and existing data volume", () => {
    expect(
      assertOwnedContainer(container(), "senmiva", root, "db", "15432").name,
    ).toBe("supabase_db_senmiva");
  });
  it.each(["name", "project", "workspace", "volume", "port"])(
    "refuses a mismatched %s before mutation",
    (field) => {
      const value = container();
      if (field === "name") value.Name = "/other-database";
      if (field === "project")
        value.Config.Labels["com.supabase.cli.project"] = "other";
      if (field === "workspace")
        value.Config.Labels["com.supabase.cli.workdir"] =
          path.resolve("other-workspace");
      if (field === "volume") value.Mounts[0].Name = "supabase_db_other";
      if (field === "port")
        value.HostConfig.PortBindings["5432/tcp"][0].HostPort = "5432";
      expect(() =>
        assertOwnedContainer(value, "senmiva", root, "db", "15432"),
      ).toThrow(/refused|requires/);
    },
  );
  it("refuses extra published ports", () => {
    const value = container();
    Object.assign(value.HostConfig.PortBindings, {
      "1234/tcp": [{ HostIp: "0.0.0.0", HostPort: "1234" }],
    });
    expect(() =>
      assertOwnedContainer(value, "senmiva", root, "db", "15432"),
    ).toThrow(/unexpected published/);
  });
  it("accepts only the local mail web port, with no host SMTP or persistent mounts", () => {
    const value = container();
    value.Name = "/supabase_inbucket_senmiva";
    value.Mounts = [];
    value.HostConfig.PortBindings = {
      "8025/tcp": [{ HostIp: "0.0.0.0", HostPort: "15434" }],
    };
    expect(
      assertOwnedContainer(value, "senmiva", root, "inbucket", "15434")
        .expectedPort,
    ).toBe("8025/tcp");
    value.HostConfig.PortBindings["1025/tcp"] = [
      { HostIp: "0.0.0.0", HostPort: "15435" },
    ];
    expect(() =>
      assertOwnedContainer(value, "senmiva", root, "inbucket", "15434"),
    ).toThrow(/unexpected published/);
  });
  it("refuses unfamiliar mail data mounts", () => {
    const value = container();
    value.Name = "/supabase_inbucket_senmiva";
    value.HostConfig.PortBindings = {
      "8025/tcp": [{ HostIp: "0.0.0.0", HostPort: "15434" }],
    };
    expect(() =>
      assertOwnedContainer(value, "senmiva", root, "inbucket", "15434"),
    ).toThrow(/persistent data mounts/);
  });
});

describe("loopback recreation", () => {
  it("archives Kong runtime files without crossing its read-only email template mount", () => {
    const paths = runtimeArchivePaths("kong");
    expect(paths).toContain("/home/kong/kong.yml");
    const templateMount = "/home/kong/templates/email/confirmation.html";
    expect(
      paths.some(
        (value) =>
          templateMount.startsWith(value + "/") || templateMount === value,
      ),
    ).toBe(false);
    expect(runtimeArchivePaths("inbucket")).toEqual([]);
    expect(() => runtimeArchivePaths("foreign")).toThrow(/unknown service/);
  });
  it("collapses public IPv4/IPv6 publications into explicit IPv4 loopback", () => {
    expect(rewriteLoopbackPorts(container().HostConfig.PortBindings)).toEqual({
      "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "15432" }],
    });
  });
  it("preserves secrets, image identity, all named data and network identity in memory", () => {
    const original = container();
    const replacement = replacementConfig(original);
    expect(replacement.Env).toEqual(original.Config.Env);
    expect(replacement.Image).toBe(original.Image);
    expect(replacement.HostConfig.Binds).toEqual(original.HostConfig.Binds);
    expect(replacement.HostConfig.Mounts).toBeUndefined();
    expect(
      replacement.NetworkingConfig.EndpointsConfig["senmiva-local"],
    ).toMatchObject({
      Aliases: ["supabase_db_senmiva"],
      IPAMConfig: { IPv4Address: "172.20.0.2" },
    });
    expect(replacement.Labels["desktop.docker.io/ports/5432/tcp"]).toBe(
      "127.0.0.1:15432",
    );
    expect(original.HostConfig.PortBindings["5432/tcp"][0].HostIp).toBe(
      "0.0.0.0",
    );
  });
  it("does not duplicate a bind without an explicit mode", () => {
    const original = container();
    original.HostConfig.Binds = [
      "supabase_db_senmiva:/var/lib/postgresql/data",
    ];
    expect(replacementConfig(original).HostConfig.Mounts).toBeUndefined();
  });
  it("recognizes actual loopback publications and rejects wildcard bindings", () => {
    const value = container();
    expect(hasLoopbackPorts(value)).toBe(false);
    value.NetworkSettings.Ports["5432/tcp"][0].HostIp = "127.0.0.1";
    expect(hasLoopbackPorts(value)).toBe(true);
  });
});

describe("local Docker engine transport", () => {
  it("supports Windows named pipes and Linux Unix sockets", () => {
    expect(engineSocket("npipe:////./pipe/dockerDesktopLinuxEngine")).toBe(
      "\\\\.\\pipe\\dockerDesktopLinuxEngine",
    );
    expect(engineSocket("unix:///var/run/docker.sock")).toBe(
      "/var/run/docker.sock",
    );
  });
  it("refuses remote Docker engines", () => {
    expect(() => engineSocket("tcp://docker.example:2376")).toThrow(
      /remote engines/,
    );
  });
});
