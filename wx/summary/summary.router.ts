import express, { Router } from "express";
import { getSummary,statistics } from "./summary.controller.ts";
const router: Router = express.Router();

router.get('/getSummary',getSummary)
router.get('/getSummary/statistics',statistics)
export default router;
