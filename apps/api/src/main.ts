import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { buildValidationPipe } from "./common/validation";
import { setupSwagger } from "./common/swagger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(buildValidationPipe());
  setupSwagger(app);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on port ${port} (docs at /api/docs)`);
}

bootstrap();
