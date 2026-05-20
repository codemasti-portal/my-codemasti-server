const mongoose = require("mongoose");

async function connectDb() {
  const main = (process.env.MONGODB_URI || "").trim();
  const direct = (process.env.MONGODB_URI_DIRECT || "").trim();

  if (!main) {
    const err = new Error("MONGODB_URI is missing in environment");
    console.error("[ERROR]", JSON.stringify({ context: "DB_CONFIG", message: err.message }));
    throw err;
  }

  const mongooseOptions = {
    serverApi: {
      version: "1",
      strict: true,
      deprecationErrors: true,
    },
  };

  /** Prefer direct host list first when SRV DNS is flaky locally (avoids failed querySrv + noisy ERROR). */
  const urisToTry = [];
  if (direct && direct !== main) {
    urisToTry.push({ uri: direct, label: "MONGODB_URI_DIRECT" });
  }
  urisToTry.push({ uri: main, label: "MONGODB_URI" });

  let lastError = null;

  for (let i = 0; i < urisToTry.length; i++) {
    const { uri, label } = urisToTry[i];
    try {
      await mongoose.connect(uri, mongooseOptions);
      await mongoose.connection.db.command({ ping: 1 });
      if (i === 0) {
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
      } else {
        console.log(`MongoDB connected using ${label} after an earlier URI attempt failed.`);
      }
      return;
    } catch (error) {
      lastError = error;
      const hasNext = i < urisToTry.length - 1;
      if (hasNext) {
        console.warn(`[DB] ${label} failed (${error.message}); trying next URI…`);
      } else {
        console.error(
          "[ERROR]",
          JSON.stringify({
            context: "DB_CONNECT_ALL_ATTEMPTS_FAILED",
            message: error.message,
            name: error.name,
          })
        );
        if (error.stack) console.error(error.stack);
        throw error;
      }
    }
  }

  throw lastError || new Error("MongoDB connection failed");
}

module.exports = { connectDb };
