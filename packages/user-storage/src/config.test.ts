import { describe, expect, it } from "vitest"

import { readUserStorageConfig } from "./config.js"

const COMPLETE = {
  USER_STORAGE_BUCKET_NAME: "user-storage",
  AWS_REGION: "ap-southeast-2",
  USER_STORAGE_ENVIRONMENT: "prod",
}

/** `COMPLETE` with one variable unset, without leaving an unused binding behind. */
function without(name: keyof typeof COMPLETE) {
  const env: Record<string, string | undefined> = { ...COMPLETE }
  delete env[name]
  return env
}

describe("readUserStorageConfig", () => {
  it("reads the three variables it needs", () => {
    expect(readUserStorageConfig(COMPLETE)).toEqual({
      bucketName: "user-storage",
      region: "ap-southeast-2",
      environment: "prod",
    })
  })

  it("accepts AWS_DEFAULT_REGION, which is what a local shell usually sets", () => {
    expect(
      readUserStorageConfig({
        ...without("AWS_REGION"),
        AWS_DEFAULT_REGION: "us-east-1",
      }).region
    ).toBe("us-east-1")
  })

  it("prefers AWS_REGION, which is what Lambda sets", () => {
    expect(
      readUserStorageConfig({
        ...COMPLETE,
        AWS_DEFAULT_REGION: "us-east-1",
      }).region
    ).toBe("ap-southeast-2")
  })

  it("treats a blank value as missing", () => {
    expect(() =>
      readUserStorageConfig({ ...COMPLETE, USER_STORAGE_BUCKET_NAME: "   " })
    ).toThrow(/USER_STORAGE_BUCKET_NAME is not set/)
  })

  for (const name of Object.keys(COMPLETE) as Array<keyof typeof COMPLETE>) {
    it(`fails when ${name} is absent`, () => {
      expect(() => readUserStorageConfig(without(name))).toThrow()
    })
  }

  it("names both region variables when neither is set", () => {
    expect(() => readUserStorageConfig(without("AWS_REGION"))).toThrow(
      /AWS_REGION is not set \(nor AWS_DEFAULT_REGION\)/
    )
  })

  /**
   * Importing this package must never throw — builds, typechecks and
   * consumers that only want the key helpers have no bucket to point at.
   * Reading configuration is therefore a call, and this is that guarantee
   * written down.
   */
  it("only touches the environment when called", () => {
    expect(() => readUserStorageConfig({})).toThrow()
    expect(readUserStorageConfig(COMPLETE).bucketName).toBe("user-storage")
  })
})
