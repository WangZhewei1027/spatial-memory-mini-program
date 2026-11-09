function withTimeout(promise, milliseconds, message, disposeLate = () => {}) {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error(message)); }, milliseconds);
    Promise.resolve(promise).then(value => {
      clearTimeout(timer);
      if (expired) disposeLate(value);
      else resolve(value);
    }, error => { clearTimeout(timer); if (!expired) reject(error); });
  });
}
module.exports = { withTimeout };
