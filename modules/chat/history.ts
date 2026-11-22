import { open, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { chatLimits, type ChatTurn } from "./types.ts";

export class ChatHistory {
  readonly turns: ChatTurn[] = [];
  private positions = new Map<string, number>();
  totalTokens = 0;
  private bytes = 0;
  private unsaved?: ChatTurn;
  private constructor(private file: string) {}

  static async open(directory: string) {
    const history = new ChatHistory(join(directory, "chat.jsonl"));
    const bytes = await readFile(history.file).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return Buffer.alloc(0);
        throw error;
      },
    );
    const end = bytes.lastIndexOf(10) + 1;
    if (end < bytes.length) await truncate(history.file, end);
    history.bytes = end;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      if (line) history.put(JSON.parse(line));
    }
    for (const turn of history.turns) {
      if (turn.status === "answering")
        await history.append({
          ...turn,
          status: "failed",
          error: "interrupted",
          activity: undefined,
        });
    }
    return history;
  }
  has(id: string) {
    return this.positions.has(id);
  }
  get(id: string) {
    const position = this.positions.get(id);
    return position === undefined ? undefined : this.turns[position];
  }
  private put(turn: ChatTurn) {
    const pos = this.positions.get(turn.id) ?? this.turns.length;
    this.totalTokens += turn.tokens - (this.turns[pos]?.tokens ?? 0);
    this.turns[pos] = turn;
    this.positions.set(turn.id, pos);
  }
  async append(turn: ChatTurn) {
    if (this.unsaved) await this.write(this.unsaved);
    this.unsaved = undefined;
    await this.write(turn);
  }
  retainAfterFailure(turn: ChatTurn) {
    this.unsaved = turn;
    this.put(turn);
  }
  private async write(turn: ChatTurn) {
    const block = Buffer.from(JSON.stringify(turn) + "\n");
    const file = await open(this.file, this.bytes ? "r+" : "w", 0o600);
    try {
      let offset = 0;
      while (offset < block.length) {
        const result = await file.write(
          block,
          offset,
          block.length - offset,
          this.bytes + offset,
        );
        if (!result.bytesWritten)
          throw new Error("Could not save the conversation");
        offset += result.bytesWritten;
      }
      // Remove the tail of any previous write that failed partway through.
      await file.truncate(this.bytes + block.length);
      this.bytes += block.length;
      this.put(turn);
    } finally {
      await file.close();
    }
  }
  page(before?: string) {
    const end = before ? this.positions.get(before) : this.turns.length;
    if (end === undefined) throw new Error("Unknown conversation cursor");
    const start = Math.max(0, end - chatLimits.page);
    return { turns: this.turns.slice(start, end), hasEarlier: start > 0 };
  }
}
