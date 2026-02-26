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
});
