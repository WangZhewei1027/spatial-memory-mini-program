/** Components emit intents; registered module handlers own business effects. */
module.exports = (component, moduleId, action, payload) => component.triggerEvent("moduleaction", { moduleId, action, payload });
