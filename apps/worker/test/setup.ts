import "reflect-metadata";
import { Logger } from "@nestjs/common";

// The ordering tests deliberately generate a lot of "waiting its turn" churn.
// Keep the output readable; failures still surface via assertions.
Logger.overrideLogger(["error", "warn"]);
