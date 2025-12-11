from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    supabase_url: str = Field(
        "https://dffscxoafddkvrufdvyi.supabase.co",
        validation_alias=AliasChoices("SUPABASE_URL"),
    )
    supabase_key: str = Field(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmZnNjeG9hZmRka3ZydWZkdnlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0MTU1NTgsImV4cCI6MjA4MDk5MTU1OH0.9VU0WImp606m_wO86DVn1F-XziosAYtFunnkZpKd1Qg",
        validation_alias=AliasChoices("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY"),
    )
    api_host: str = Field("0.0.0.0", validation_alias=AliasChoices("API_HOST"))
    api_port: int = Field(8000, validation_alias=AliasChoices("API_PORT"))

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        populate_by_name=True,
    )


settings = Settings()
