from pydantic import BaseSettings, Field


class Settings(BaseSettings):
    supabase_url: str = Field(
        "https://dffscxoafddkvrufdvyi.supabase.co", env="SUPABASE_URL"
    )
    supabase_key: str = Field(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmZnNjeG9hZmRka3ZydWZkdnlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0MTU1NTgsImV4cCI6MjA4MDk5MTU1OH0.9VU0WImp606m_wO86DVn1F-XziosAYtFunnkZpKd1Qg",
        env="SUPABASE_SERVICE_ROLE_KEY",
    )
    api_host: str = Field("0.0.0.0", env="API_HOST")
    api_port: int = Field(8000, env="API_PORT")

    class Config:
        env_file = ".env"


settings = Settings(_env_file='.env', _env_file_encoding='utf-8')
