import express, { Router } from "express";
import { publishDraft } from './wxDraft.controller.ts';

const router: Router = express.Router();

// POST /hip/wx/draft/publish — Markdown 发布为公众号草稿（JSON，纯透传）
router.post('/publish', publishDraft);

export default router;
