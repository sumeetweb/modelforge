import { App } from "aws-cdk-lib";
import { Foundation, Platform } from "../lib/stacks";
const app = new App();
const foundation = new Foundation(app, "ModelForgeFoundation");
new Platform(app, "ModelForgePlatform", { foundation });
