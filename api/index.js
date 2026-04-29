const app = require("../src/app");
const { connectDb } = require("../src/config/db");

let dbReadyPromise = null;

module.exports = async (req, res) => {
  if (!dbReadyPromise) {
    dbReadyPromise = connectDb();
  }

  await dbReadyPromise;
  return app(req, res);
};
