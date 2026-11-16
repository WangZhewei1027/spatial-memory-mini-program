const { CONFIG, fetchActivities, fetchActivityRecords } = require("../../../utils/backend");
const { reportError } = require("../../../utils/report-error");
const { acceptActivityDiscovery, isCurrentActivityDiscovery, nextActivityDiscoverySequence, parseActivityPlacements, validActivityLocation, withinActivityScope } = require("../../../utils/activity-state");

/** Activity discovery owns its requests and revisions; the sink owns presentation. */
function createActivitySource({ capture, getLocation, onRecords, onRemove, onDiscovery, maxDistanceMeters = 20 }) {
  let revision = 0, nextFetch = 0, pending = null;
  const placements = new Map();
  function remove(ids) {
    for (const id of ids) placements.delete(id);
    onRemove(ids);
  }
  const source = {
    reset() { revision++; nextFetch = 0; pending = null; placements.clear(); },
    accept(id, placement) { placements.set(id, placement); revision++; nextFetch = 0; },
    replace(records) {
      const next = new Map(records.map(record => [record.id, record.activity_placement_id]));
      remove(new Set([...placements.keys()].filter(id => !next.has(id))));
      placements.clear(); for (const [id, placement] of next) placements.set(id, placement);
      onRecords(records);
    },
    applyAvailability(activities, sequence) {
      if (!isCurrentActivityDiscovery(sequence)) return;
      const enabled = new Set(activities.filter(a => a.type === "danmaku" && withinActivityScope(a, getLocation())).map(a => a.id));
      remove(new Set([...placements].filter(([, placement]) => !enabled.has(placement)).map(([id]) => id)));
    },
    async refresh(force = false) {
      const alive = capture();
      if (!alive() || pending || (!force && Date.now() < nextFetch)) return;
      nextFetch = Date.now() + 10000;
      const request = { revision, sequence: nextActivityDiscoverySequence() };
      pending = request;
      const location = getLocation(), organizationId = CONFIG.organizationId, workspaceId = CONFIG.workspaceId;
      const current = () => alive() && request.revision === revision && organizationId === CONFIG.organizationId &&
        workspaceId === CONFIG.workspaceId && isCurrentActivityDiscovery(request.sequence);
      try {
        if (!organizationId || !validActivityLocation(location)) { source.replace([]); return; }
        const response = await fetchActivities(workspaceId, organizationId);
        if (!current()) return;
        if (response.statusCode !== 200) throw new Error("活动加载失败");
        const activities = parseActivityPlacements(response.data, !workspaceId);
        if (!acceptActivityDiscovery(request.sequence)) return;
        source.applyAvailability(activities, request.sequence);
        onDiscovery({ activities, discoverySequence: request.sequence });
        const deployments = activities.filter(a => a.type === "danmaku" && withinActivityScope(a, location));
        const records = [];
        for (let start = 0; start < deployments.length; start += 4) {
          const groups = await Promise.all(deployments.slice(start, start + 4).map(async activity => {
            try {
              const result = await fetchActivityRecords(activity.id, location, maxDistanceMeters);
              if (result.statusCode !== 200 || !Array.isArray(result.data)) return [];
              return result.data.filter(record => record && typeof record.id === "string" && record.activity_placement_id === activity.id &&
                record.activity_id === activity.activity_id && record.file_type === "text" && typeof record.text_content === "string" && validActivityLocation(record.metadata));
            } catch (error) { reportError("activities.records", error, { activityId: activity.id }); return []; }
          }));
          if (!current()) return;
          for (const group of groups) records.push(...group);
        }
        if (current()) source.replace(records);
      } catch (error) {
        if (!current()) return;
        acceptActivityDiscovery(request.sequence);
        reportError("activities.refresh", error);
        source.replace([]);
        onDiscovery({ activities: [], error: true, discoverySequence: request.sequence });
      } finally { if (pending === request) pending = null; }
    },
  };
  return source;
}
module.exports = { createActivitySource };
