"""Supabase client setup shared across the backend."""

import logging

from supabase import Client, create_client

from .config import settings

logger = logging.getLogger(__name__)

if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
    logger.warning("Supabase credentials are not fully configured. Check your .env file.")

supabase: Client = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
