import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

async function handleOAuthCallback(req: Request, res: Response) {
  const code = getQueryParam(req, "code");
  const state = getQueryParam(req, "state");

  console.log("[OAuth] callback hit:", req.path);
  console.log("[OAuth] query params:", JSON.stringify(req.query));
  console.log("[OAuth] code:", code ? `${code.substring(0, 20)}...` : "MISSING");
  console.log("[OAuth] state:", state ? `${state.substring(0, 60)}...` : "MISSING");
  if (state) {
    try {
      const decoded = atob(state);
      console.log("[OAuth] state decoded:", decoded);
    } catch {
      console.log("[OAuth] state is not base64");
    }
  }

  if (!code || !state) {
    console.error("[OAuth] Missing code or state — redirecting to login");
    res.redirect(302, "/?error=login_required");
    return;
  }

  try {
    const tokenResponse = await sdk.exchangeCodeForToken(code, state);
    const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

    console.log("[OAuth] userInfo openId:", userInfo.openId);

    if (!userInfo.openId) {
      console.error("[OAuth] openId missing from user info");
      res.status(400).json({ error: "OAuth user missing openId" });
      return;
    }

    await db.upsertUser({
      openId: userInfo.openId,
      name: userInfo.name || null,
      email: userInfo.email ?? null,
      loginMethod: userInfo.loginMethod ?? (userInfo as any).platform ?? null,
      lastSignedIn: new Date(),
    });

    const sessionToken = await sdk.createSessionToken(userInfo.openId, {
      name: userInfo.name || "",
      expiresInMs: ONE_YEAR_MS,
    });

    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

    // Redirect to the origin encoded in state, or fallback to /
    let redirectTo = "/";
    try {
      const decoded = atob(state);
      const url = new URL(decoded);
      redirectTo = url.origin + "/";
    } catch { /* use default */ }

    console.log("[OAuth] Login success, redirecting to:", redirectTo);
    res.redirect(302, redirectTo);
  } catch (error: any) {
    const detail = error?.response?.data
      ? JSON.stringify(error.response.data)
      : String(error);
    console.error("[OAuth] Callback failed:", detail);
    res.status(500).json({ error: "OAuth callback failed", detail });
  }
}

export function registerOAuthRoutes(app: Express) {
  // Both paths handled by the same function
  // /api/oauth/callback — guaranteed to reach Express (all /api/* routes go to backend)
  app.get("/api/oauth/callback", handleOAuthCallback);
  // /manus-oauth/callback — Manus platform may use this in some configurations
  app.get("/manus-oauth/callback", handleOAuthCallback);
}
