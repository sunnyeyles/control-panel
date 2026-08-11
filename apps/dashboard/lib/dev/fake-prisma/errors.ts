export class DevPrismaError extends Error {
  constructor(operation: string, detail: string) {
    super(
      `The DEV_AUTH_BYPASS fake database does not implement ${operation}. ${detail}`
    )
    this.name = "DevPrismaError"
  }
}

export function notFound(): Error & { code: string } {
  return Object.assign(new Error("Record to update not found."), {
    code: "P2025",
  })
}
