/**
 * Store for user-supplied OpenCode JSON configuration.
 *
 * Supports two scopes:
 * - 'global': applies to all sessions
 * - 'repo:{owner}/{name}': repo-specific override (merged on top of global)
 */

export class OpenCodeConfigStore {
  constructor(private readonly db: D1Database) {}

  private globalScope(): string {
    return "global";
  }

  private repoScope(owner: string, name: string): string {
    return `repo:${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /**
   * Get the global OpenCode config JSON string, or null if not set.
   */
  async getGlobalConfig(): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT config_json FROM opencode_config WHERE scope = ?")
      .bind(this.globalScope())
      .first<{ config_json: string }>();

    return row?.config_json ?? null;
  }

  /**
   * Set the global OpenCode config JSON string.
   */
  async setGlobalConfig(json: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO opencode_config (scope, config_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(scope) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .bind(this.globalScope(), json)
      .run();
  }

  /**
   * Delete the global OpenCode config.
   */
  async deleteGlobalConfig(): Promise<void> {
    await this.db
      .prepare("DELETE FROM opencode_config WHERE scope = ?")
      .bind(this.globalScope())
      .run();
  }

  /**
   * Get the repo-scoped OpenCode config JSON string, or null if not set.
   */
  async getRepoConfig(owner: string, name: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT config_json FROM opencode_config WHERE scope = ?")
      .bind(this.repoScope(owner, name))
      .first<{ config_json: string }>();

    return row?.config_json ?? null;
  }

  /**
   * Set the repo-scoped OpenCode config JSON string.
   */
  async setRepoConfig(owner: string, name: string, json: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO opencode_config (scope, config_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(scope) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .bind(this.repoScope(owner, name), json)
      .run();
  }

  /**
   * Delete the repo-scoped OpenCode config.
   */
  async deleteRepoConfig(owner: string, name: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM opencode_config WHERE scope = ?")
      .bind(this.repoScope(owner, name))
      .run();
  }
}
