import { Router } from "express";
import { registerUser, login } from "../controllers/auth.controller"
import { uploadVideo } from "../controllers/video.controller"
import { validateBody } from "../middlewares/validate-body.middleware";
import { validateAuthToken } from "../middlewares/validate-auth-token.middleware";
import { registerSchema, loginSchema } from "../types/auth.types";
import { videoUploadSchema } from "../types/video.types";

const router = Router();

router.post("/auth/register", validateBody(registerSchema), registerUser);
router.post("/auth/login", validateBody(loginSchema), login);
router.post("/videos", validateAuthToken, validateBody(videoUploadSchema), uploadVideo);

export default router;