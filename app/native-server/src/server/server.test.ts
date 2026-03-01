import { describe, expect, test, afterAll, beforeAll } from "@jest/globals";
import supertest from "supertest";
import Server from "./index";

describe("test", () => {
  // Start a server test instance
  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  // Shut down the server
  afterAll(async () => {
    await Server.stop();
  });

  test("GET /ping ok", async () => {
    const response = await supertest(Server.getInstance().server)
      .get("/ping")
      .expect(200)
      .expect("Content-Type", /json/);

    expect(response.body).toEqual({
      status: "ok",
      message: "pong",
    });
  });

  test("GET /agent/engines returns 200 when auth is disabled", async () => {
    const previous = process.env.WEBPAGE_MCP_AUTH_TOKEN;
    delete process.env.WEBPAGE_MCP_AUTH_TOKEN;
    try {
      const response = await supertest(Server.getInstance().server)
        .get("/agent/engines")
        .expect(200)
        .expect("Content-Type", /json/);
      expect(Array.isArray(response.body.engines)).toBe(true);
    } finally {
      if (typeof previous === "string") {
        process.env.WEBPAGE_MCP_AUTH_TOKEN = previous;
      } else {
        delete process.env.WEBPAGE_MCP_AUTH_TOKEN;
      }
    }
  });

  test("GET /agent/engines returns 401 when auth token is enabled and missing", async () => {
    const previous = process.env.WEBPAGE_MCP_AUTH_TOKEN;
    process.env.WEBPAGE_MCP_AUTH_TOKEN = "unit-test-token";
    try {
      const response = await supertest(Server.getInstance().server)
        .get("/agent/engines")
        .expect(401)
        .expect("Content-Type", /json/);
      expect(response.body).toEqual({ error: "Unauthorized" });
    } finally {
      if (typeof previous === "string") {
        process.env.WEBPAGE_MCP_AUTH_TOKEN = previous;
      } else {
        delete process.env.WEBPAGE_MCP_AUTH_TOKEN;
      }
    }
  });

  test("GET /agent/engines accepts valid auth token and reaches route handler", async () => {
    const previous = process.env.WEBPAGE_MCP_AUTH_TOKEN;
    process.env.WEBPAGE_MCP_AUTH_TOKEN = "unit-test-token";
    try {
      const response = await supertest(Server.getInstance().server)
        .get("/agent/engines")
        .set("Authorization", "Bearer unit-test-token")
        .expect(200)
        .expect("Content-Type", /json/);
      expect(Array.isArray(response.body.engines)).toBe(true);
    } finally {
      if (typeof previous === "string") {
        process.env.WEBPAGE_MCP_AUTH_TOKEN = previous;
      } else {
        delete process.env.WEBPAGE_MCP_AUTH_TOKEN;
      }
    }
  });

  test("GET /ping remains unauthenticated when auth token is enabled", async () => {
    const previous = process.env.WEBPAGE_MCP_AUTH_TOKEN;
    process.env.WEBPAGE_MCP_AUTH_TOKEN = "unit-test-token";
    try {
      const response = await supertest(Server.getInstance().server)
        .get("/ping")
        .expect(200)
        .expect("Content-Type", /json/);
      expect(response.body).toEqual({
        status: "ok",
        message: "pong",
      });
    } finally {
      if (typeof previous === "string") {
        process.env.WEBPAGE_MCP_AUTH_TOKEN = previous;
      } else {
        delete process.env.WEBPAGE_MCP_AUTH_TOKEN;
      }
    }
  });
});
