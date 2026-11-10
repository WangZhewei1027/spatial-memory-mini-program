// Reference embeddings keyed by anchor id, reused only for the same
// reference_version and the same organization/map scope. Bounded LRU.
class ReferenceCache {
  constructor(limit) {
    this.limit = limit;
    this.scope = null;
    this.entries = new Map();
  }
  get size() { return this.entries.size; }
  // Entering another organization/map drops every entry from the previous scope.
  useScope(scope) {
    if (this.scope !== scope) this.entries = new Map();
    this.scope = scope;
  }
  clear() {
    this.entries = new Map();
    this.scope = null;
  }
  // Returns the cached entry for this exact version, discarding a stale one.
  lookup(id, version) {
    const entry = this.entries.get(id);
    if (entry?.version === version) return entry;
    this.entries.delete(id);
    return null;
  }
  remember(id, entry) {
    this.entries.delete(id);
    this.entries.set(id, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }
  // Touch every reusable entry before inserting new ones, so LRU eviction cannot
  // remove an unchanged reference that appears later in the same response.
  protect(candidates) {
    for (const candidate of candidates) {
      const entry = this.entries.get(candidate.id);
      if (entry?.version === candidate.reference_version) this.remember(candidate.id, entry);
    }
  }
}
module.exports = { ReferenceCache };
