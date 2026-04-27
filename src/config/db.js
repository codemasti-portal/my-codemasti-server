const mongoose = require("mongoose");

async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
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

  try {
    await mongoose.connect(uri, mongooseOptions);
    await mongoose.connection.db.command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
    return;
  } catch (error) {
    console.error(
      "[ERROR]",
      JSON.stringify({
        context: "DB_CONNECT_PRIMARY",
        message: error.message,
        name: error.name,
      })
    );
    if (error.stack) console.error(error.stack);
    const isSrvDnsError = String(error.message || "").includes("querySrv");
    const directUri = process.env.MONGODB_URI_DIRECT;

    if (!isSrvDnsError || !directUri) {
      throw error;
    }

    console.warn("SRV DNS resolution failed. Retrying with MONGODB_URI_DIRECT...");
    try {
      await mongoose.connect(directUri, mongooseOptions);
      await mongoose.connection.db.command({ ping: 1 });
      console.log("MongoDB connected using direct URI fallback.");
    } catch (fallbackError) {
      console.error(
        "[ERROR]",
        JSON.stringify({
          context: "DB_CONNECT_FALLBACK",
          message: fallbackError.message,
          name: fallbackError.name,
        })
      );
      if (fallbackError.stack) console.error(fallbackError.stack);
      throw fallbackError;
    }
  }
}

module.exports = { connectDb };
