"""Supabase client setup shared across the backend."""

import logging

from supabase import Client, create_client

from .config import settings

logger = logging.getLogger(__name__)

if not settings.SUPABASE_URL or not settings.supabase_secret:
    logger.warning("Supabase credentials are not fully configured. Check your .env file.")

if settings.supabase_secret.startswith("sb_secret_"):
    logger.error(
        "Supabase API key looks like a JWT secret (sb_secret). "
        "Use the service_role or anon API key from Project Settings > API."
    )

supabase: Client = create_client(settings.SUPABASE_URL, settings.supabase_secret)
