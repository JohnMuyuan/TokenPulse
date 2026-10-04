#!/usr/bin/env python3
"""TokenPulse: save the Prism session after the user signed in with their own browser.

The sign-in window is the installed Chrome / Edge started the ordinary way on a dedicated profile
(PRISM_PROFILE_DIR), with nothing driving it. Once that window is closed, this reads the cookies
out of the same profile (no page is loaded) and stores them the way `bridge.py login` does.

Exit code 0: session saved. 2: no valid Prism session in the profile.
"""
import sys
import time

from playwright.sync_api import sync_playwright

import bridge


def main() -> int:
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(bridge.PROFILE_DIR),
            headless=True,
            args=["--no-first-run", "--no-default-browser-check"],
            **({"channel": bridge.LOGIN_CHANNEL} if bridge.LOGIN_CHANNEL else {}),
        )
        cookie = bridge.context_cookie_header(context)
        context.close()
    claims = bridge.get_token_claims(cookie)
    if claims.get("user_id") and bridge.token_expiry(cookie) > time.time() + 60:
        bridge.save_auth_cookie(cookie)
        print("[login] Prism session saved", flush=True)
        return 0
    print("[login] no valid Prism session in the sign-in browser", flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(main())
