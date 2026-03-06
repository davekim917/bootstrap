#!/usr/bin/env bash
# Phase 0: Ground Truth Discovery
# Fast, deterministic baseline for AI discovery to verify against
#
# Purpose: Provides hard counts and Y/N detection that the AI uses as
# verification baseline. NOT a comprehensive discovery tool - that's
# what Serena + grep do in Stage 1.
#
# Usage: cd <project_root> && bash discovery-commands.sh

set -euo pipefail

echo "=== Ground Truth Discovery ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# === Security Check (CRITICAL - runs first) ===
echo "=== SECURITY: Sensitive Files ==="
sensitive_files=$(find . -maxdepth 3 -type f \( \
  -name ".env*" -o -name "*secret*" -o -name "*credential*" -o \
  -name "*password*" -o -name "*.key" -o -name "*.pem" \
\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*" -not -path "*/.claude/*" 2>/dev/null | head -10 || true)
if [ -n "$sensitive_files" ]; then
  echo "$sensitive_files"
  echo "!! Found sensitive files above - contents will be protected"
else
  echo "(none found)"
fi
echo "---"

# === Environment & Git Setup ===
if git rev-parse --git-dir > /dev/null 2>&1; then
  IS_GIT_REPO=true
  FILE_LIST_CMD="git ls-files"
else
  IS_GIT_REPO=false
  FILE_LIST_CMD="find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.claude/*' -not -path '*/venv/*' -not -path '*/.venv/*'"
fi

# Helper: Check if jq is available
HAS_JQ=false
command -v jq >/dev/null 2>&1 && HAS_JQ=true

# Helper: Check package.json for dependency
pkg_has() {
  if [ "$HAS_JQ" = true ] && [ -f "package.json" ]; then
    jq -e ".dependencies[\"$1\"] // .devDependencies[\"$1\"]" package.json >/dev/null 2>&1 && echo Y || echo N
  else
    echo N
  fi
}

# Helper: grep Python files (excludes venvs, node_modules, .git)
py_grep() {
  grep -r --include="*.py" --exclude-dir=venv --exclude-dir=.venv \
    --exclude-dir=site-packages --exclude-dir=node_modules --exclude-dir=.git \
    "$@" . 2>/dev/null | head -1 || true
}

# Helper: returns 0 (true) if any argument is non-empty
has_any() {
  for v in "$@"; do [[ -n "$v" ]] && return 0; done
  return 1
}

# === Tech Stack Detection ===
echo "=== Tech Stack Detection ==="

# Frontend (use package.json for React to avoid false positives from aliased imports)
has_nextjs=$(find . -maxdepth 2 \( -name "next.config.js" -o -name "next.config.mjs" -o -name "next.config.ts" \) -not -path "*/node_modules/*" 2>/dev/null | head -1)
has_react=$(pkg_has "react")
has_vue=$(find . -maxdepth 4 -name "*.vue" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_angular=$(find . -maxdepth 2 -name "angular.json" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_svelte=$(find . -maxdepth 4 -name "*.svelte" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
printf "Frontend: Next.js[%s] React[%s] Vue[%s] Angular[%s] Svelte[%s]\n" \
  "$([[ -n "$has_nextjs" ]] && echo Y || echo N)" \
  "$has_react" \
  "$([[ -n "$has_vue" ]] && echo Y || echo N)" \
  "$([[ -n "$has_angular" ]] && echo Y || echo N)" \
  "$([[ -n "$has_svelte" ]] && echo Y || echo N)"

# Backend (use package.json for JS frameworks to avoid false positives)
has_express=$(pkg_has "express")
has_nestjs=$(find . -maxdepth 2 -name "nest-cli.json" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_django=$(find . -maxdepth 3 -name "manage.py" -not -path "*/venv/*" -not -path "*/.venv/*" -exec grep -l "django" {} + 2>/dev/null | head -1 || true)
has_flask=$(py_grep "from flask\|import flask")
has_fastapi=$(py_grep "from fastapi\|import fastapi")
printf "Backend: Express[%s] NestJS[%s] Django[%s] Flask[%s] FastAPI[%s]\n" \
  "$has_express" \
  "$([[ -n "$has_nestjs" ]] && echo Y || echo N)" \
  "$([[ -n "$has_django" ]] && echo Y || echo N)" \
  "$([[ -n "$has_flask" ]] && echo Y || echo N)" \
  "$([[ -n "$has_fastapi" ]] && echo Y || echo N)"

# Database/ORM (use package.json for JS ORMs)
has_prisma=$(find . -maxdepth 3 -name "schema.prisma" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_drizzle=$(find . -maxdepth 3 -name "drizzle.config.*" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_typeorm=$(pkg_has "typeorm")
has_mongoose=$(pkg_has "mongoose")
has_sqlalchemy=$(grep -r --include="*.py" --exclude-dir=venv --exclude-dir=.venv --exclude-dir=site-packages "from sqlalchemy\|import sqlalchemy" . 2>/dev/null | head -1 || true)
has_django_orm=$(find . -maxdepth 3 -name "models.py" -not -path "*/venv/*" -not -path "*/.venv/*" -exec grep -l "from django.db" {} + 2>/dev/null | head -1 || true)
printf "ORM: Prisma[%s] Drizzle[%s] TypeORM[%s] Mongoose[%s] SQLAlchemy[%s] Django[%s]\n" \
  "$([[ -n "$has_prisma" ]] && echo Y || echo N)" \
  "$([[ -n "$has_drizzle" ]] && echo Y || echo N)" \
  "$has_typeorm" \
  "$has_mongoose" \
  "$([[ -n "$has_sqlalchemy" ]] && echo Y || echo N)" \
  "$([[ -n "$has_django_orm" ]] && echo Y || echo N)"

# Monorepo
has_nx=$(find . -maxdepth 1 -name "nx.json" 2>/dev/null | head -1 || true)
has_turbo=$(find . -maxdepth 1 -name "turbo.json" 2>/dev/null | head -1 || true)
has_pnpm_ws=$(find . -maxdepth 1 -name "pnpm-workspace.yaml" 2>/dev/null | head -1 || true)
printf "Monorepo: Nx[%s] Turborepo[%s] pnpm-workspaces[%s]\n" \
  "$([[ -n "$has_nx" ]] && echo Y || echo N)" \
  "$([[ -n "$has_turbo" ]] && echo Y || echo N)" \
  "$([[ -n "$has_pnpm_ws" ]] && echo Y || echo N)"

# CI/CD
has_gha=$(find .github/workflows \( -name "*.yml" -o -name "*.yaml" \) 2>/dev/null | head -1 || true)
has_gitlab=$(find . -maxdepth 1 -name ".gitlab-ci.yml" 2>/dev/null | head -1 || true)
printf "CI/CD: GitHub Actions[%s] GitLab CI[%s]\n" \
  "$([[ -n "$has_gha" ]] && echo Y || echo N)" \
  "$([[ -n "$has_gitlab" ]] && echo Y || echo N)"

# API Patterns
has_graphql=$(find . -maxdepth 4 \( -name "*.graphql" -o -name "*.gql" \) -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_trpc=$(pkg_has "@trpc/server")
has_openapi=$(find . -maxdepth 3 \( -name "openapi.*" -o -name "swagger.*" \) -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
printf "API: GraphQL[%s] tRPC[%s] OpenAPI[%s]\n" \
  "$([[ -n "$has_graphql" ]] && echo Y || echo N)" \
  "$has_trpc" \
  "$([[ -n "$has_openapi" ]] && echo Y || echo N)"

# Testing
has_jest=$(find . -maxdepth 2 \( -name "jest.config.*" -o -name "jest.setup.*" \) -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_vitest=$(find . -maxdepth 2 -name "vitest.config.*" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_pytest=$(find . -maxdepth 2 \( -name "pytest.ini" -o -name "conftest.py" \) -not -path "*/venv/*" -not -path "*/.venv/*" 2>/dev/null | head -1 || true)
has_playwright=$(find . -maxdepth 2 -name "playwright.config.*" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
printf "Testing: Jest[%s] Vitest[%s] Pytest[%s] Playwright[%s]\n" \
  "$([[ -n "$has_jest" ]] && echo Y || echo N)" \
  "$([[ -n "$has_vitest" ]] && echo Y || echo N)" \
  "$([[ -n "$has_pytest" ]] && echo Y || echo N)" \
  "$([[ -n "$has_playwright" ]] && echo Y || echo N)"

# Linting
has_eslint=$(find . -maxdepth 2 \( -name ".eslintrc*" -o -name "eslint.config.*" \) -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_prettier=$(find . -maxdepth 2 \( -name ".prettierrc*" -o -name "prettier.config.*" \) -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_biome=$(find . -maxdepth 2 -name "biome.json" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
printf "Linting: ESLint[%s] Prettier[%s] Biome[%s]\n" \
  "$([[ -n "$has_eslint" ]] && echo Y || echo N)" \
  "$([[ -n "$has_prettier" ]] && echo Y || echo N)" \
  "$([[ -n "$has_biome" ]] && echo Y || echo N)"
echo "---"

# === Data & ML Stack Detection ===
echo "=== Data & ML Stack Detection ==="

# dbt
has_dbt=$(find . -maxdepth 3 -name "dbt_project.yml" 2>/dev/null | head -1 || true)
has_dbt_profiles=$(find . -maxdepth 3 -name "profiles.yml" -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
printf "dbt: project[%s] profiles[%s]\n" \
  "$([[ -n "$has_dbt" ]] && echo Y || echo N)" \
  "$([[ -n "$has_dbt_profiles" ]] && echo Y || echo N)"

# ML/DS
has_notebooks=$(find . -maxdepth 5 -name "*.ipynb" -not -path "*/.ipynb_checkpoints/*" 2>/dev/null | head -1 || true)
has_mlproject=$(find . -maxdepth 2 \( -name "MLproject" -o -name "mlflow.yml" \) 2>/dev/null | head -1 || true)
has_torch=$(grep -r --include="*.py" --exclude-dir=venv --exclude-dir=.venv --exclude-dir=site-packages "import torch\|from torch" . 2>/dev/null | head -1 || true)
has_tensorflow=$(grep -r --include="*.py" --exclude-dir=venv --exclude-dir=.venv --exclude-dir=site-packages "import tensorflow\|from tensorflow" . 2>/dev/null | head -1 || true)
has_sklearn=$(grep -r --include="*.py" --exclude-dir=venv --exclude-dir=.venv --exclude-dir=site-packages "from sklearn\|import sklearn" . 2>/dev/null | head -1 || true)
printf "ML/DS: Notebooks[%s] MLflow[%s] PyTorch[%s] TensorFlow[%s] Scikit-learn[%s]\n" \
  "$([[ -n "$has_notebooks" ]] && echo Y || echo N)" \
  "$([[ -n "$has_mlproject" ]] && echo Y || echo N)" \
  "$([[ -n "$has_torch" ]] && echo Y || echo N)" \
  "$([[ -n "$has_tensorflow" ]] && echo Y || echo N)" \
  "$([[ -n "$has_sklearn" ]] && echo Y || echo N)"

# Data Engineering / Orchestration
has_airflow=$(find . -maxdepth 3 \( -name "airflow.cfg" -o -name "airflow_settings.yaml" \) 2>/dev/null | head -1 || true)
has_airflow_dags=$(py_grep "from airflow")
has_dagster=$(find . -maxdepth 3 \( -name "dagster.yaml" -o -name "workspace.yaml" \) 2>/dev/null | head -1 || true)
has_prefect=$(py_grep "from prefect\|import prefect")
has_spark=$(py_grep "from pyspark\|import pyspark")
has_duckdb=$(py_grep "import duckdb\|from duckdb")
has_polars=$(py_grep "import polars\|from polars")
has_dlt=$(py_grep "import dlt\|from dlt")
printf "Data Eng: Airflow[%s] Airflow DAGs[%s] Dagster[%s] Prefect[%s] Spark[%s] DuckDB[%s] Polars[%s] dlt[%s]\n" \
  "$([[ -n "$has_airflow" ]] && echo Y || echo N)" \
  "$([[ -n "$has_airflow_dags" ]] && echo Y || echo N)" \
  "$([[ -n "$has_dagster" ]] && echo Y || echo N)" \
  "$([[ -n "$has_prefect" ]] && echo Y || echo N)" \
  "$([[ -n "$has_spark" ]] && echo Y || echo N)" \
  "$([[ -n "$has_duckdb" ]] && echo Y || echo N)" \
  "$([[ -n "$has_polars" ]] && echo Y || echo N)" \
  "$([[ -n "$has_dlt" ]] && echo Y || echo N)"

# Analytics / BI
has_lookml=$(find . -maxdepth 4 \( -name "*.lookml" -o -name "*.lkml" \) 2>/dev/null | head -1 || true)
has_great_expectations=$(find . -maxdepth 3 -name "great_expectations.yml" 2>/dev/null | head -1 || true)
# Omni Analytics: two-step — find *.view.yaml/*.topic.yaml then verify Omni content
# Check view files for dimensions:/measures:, topic files for base_view:/joins:
has_omni=""
_omni_view=$(find . -name "*.view.yaml" -not -path "*/node_modules/*" -not -path "*/.claude/*" 2>/dev/null | head -1 || true)
if [[ -n "$_omni_view" ]]; then
  has_omni=$(grep -l "dimensions:\|measures:" "$_omni_view" 2>/dev/null || true)
fi
if [[ -z "$has_omni" ]]; then
  _omni_topic=$(find . -name "*.topic.yaml" -not -path "*/node_modules/*" -not -path "*/.claude/*" 2>/dev/null | head -1 || true)
  if [[ -n "$_omni_topic" ]]; then
    has_omni=$(grep -l "base_view:\|joins:" "$_omni_topic" 2>/dev/null || true)
  fi
fi
has_cube=$(find . -maxdepth 3 \( -name "cube.js" -o -name ".cuberc.yaml" -o -name "cubejs.yml" \) -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
has_lightdash=$(find . -maxdepth 3 \( -name "lightdash.yml" -o -name "lightdash.config.yml" \) 2>/dev/null | head -1 || true)
has_malloy=$(find . -name "*.malloy" 2>/dev/null | head -1 || true)
has_evidence=$(find . -maxdepth 3 \( -name "evidence.config.yaml" -o -name "evidence.plugins.yaml" \) 2>/dev/null | head -1 || true)
has_holistics=$(find . -name "*.aml" 2>/dev/null | head -1 || true)
has_dataform=$(find . -maxdepth 3 -name "dataform.json" 2>/dev/null | head -1 || true)
has_superset=$(find . -maxdepth 3 -name "superset_config.py" 2>/dev/null | head -1 || true)
has_soda=$(find . -maxdepth 3 -name "soda-checks.yml" 2>/dev/null | head -1 || true)
has_dbt_semantic=$(find . -maxdepth 3 -name "semantic_manifest.json" 2>/dev/null | head -1 || true)
if [[ -z "$has_dbt_semantic" ]]; then
  has_dbt_semantic=$(grep -r --include="*.yml" --include="*.yaml" "semantic_models:" . 2>/dev/null | head -1 || true)
fi
has_tableau=$(find . -maxdepth 4 \( -name "*.twb" -o -name "*.twbx" -o -name "*.tds" \) 2>/dev/null | head -1 || true)
has_metabase=$(find . -maxdepth 3 -name "metabase.db" 2>/dev/null | head -1 || true)
printf "Analytics: LookML[%s] Great Expectations[%s] Omni[%s] Cube[%s] Lightdash[%s] Malloy[%s] Evidence[%s] Holistics[%s] Dataform[%s] Superset[%s] Soda[%s] dbt-Semantic[%s] Tableau[%s] Metabase[%s]\n" \
  "$([[ -n "$has_lookml" ]] && echo Y || echo N)" \
  "$([[ -n "$has_great_expectations" ]] && echo Y || echo N)" \
  "$([[ -n "$has_omni" ]] && echo Y || echo N)" \
  "$([[ -n "$has_cube" ]] && echo Y || echo N)" \
  "$([[ -n "$has_lightdash" ]] && echo Y || echo N)" \
  "$([[ -n "$has_malloy" ]] && echo Y || echo N)" \
  "$([[ -n "$has_evidence" ]] && echo Y || echo N)" \
  "$([[ -n "$has_holistics" ]] && echo Y || echo N)" \
  "$([[ -n "$has_dataform" ]] && echo Y || echo N)" \
  "$([[ -n "$has_superset" ]] && echo Y || echo N)" \
  "$([[ -n "$has_soda" ]] && echo Y || echo N)" \
  "$([[ -n "$has_dbt_semantic" ]] && echo Y || echo N)" \
  "$([[ -n "$has_tableau" ]] && echo Y || echo N)" \
  "$([[ -n "$has_metabase" ]] && echo Y || echo N)"
echo "---"

# === AI/LLM Stack Detection ===
echo "=== AI/LLM Stack Detection ==="
# Batch single-pass grep for LLM SDKs (bypass py_grep to get multi-line results)
_ai_sdk_hits=$(grep -r --include="*.py" --exclude-dir=venv --exclude-dir=.venv \
  --exclude-dir=site-packages --exclude-dir=node_modules --exclude-dir=.git \
  "from openai\|import openai\|from anthropic\|import anthropic\|from langchain\|from llama_index" \
  . 2>/dev/null || true)
has_openai=""; has_anthropic=""; has_langchain=""; has_llama_index=""
if [[ -n "$_ai_sdk_hits" ]]; then
  echo "$_ai_sdk_hits" | grep -q "openai" && has_openai="Y"
  echo "$_ai_sdk_hits" | grep -q "anthropic" && has_anthropic="Y"
  echo "$_ai_sdk_hits" | grep -q "langchain" && has_langchain="Y"
  echo "$_ai_sdk_hits" | grep -q "llama_index" && has_llama_index="Y"
fi
# JS equivalents
has_openai_js=$(pkg_has "openai")
has_anthropic_js=$(pkg_has "@anthropic-ai/sdk")
has_langchain_js=$(pkg_has "langchain")
[[ "$has_openai_js" == "Y" ]] && has_openai="Y"
[[ "$has_anthropic_js" == "Y" ]] && has_anthropic="Y"
[[ "$has_langchain_js" == "Y" ]] && has_langchain="Y"
printf "LLM SDKs: OpenAI[%s] Anthropic[%s] LangChain[%s] LlamaIndex[%s]\n" \
  "$([[ -n "$has_openai" ]] && echo Y || echo N)" \
  "$([[ -n "$has_anthropic" ]] && echo Y || echo N)" \
  "$([[ -n "$has_langchain" ]] && echo Y || echo N)" \
  "$([[ -n "$has_llama_index" ]] && echo Y || echo N)"

# Vector stores
has_chromadb=$(py_grep "import chromadb\|from chromadb")
has_pinecone=$(py_grep "import pinecone\|from pinecone")
has_weaviate=$(py_grep "import weaviate\|from weaviate")
has_qdrant=$(py_grep "from qdrant_client\|import qdrant")
has_pgvector=$(py_grep "from pgvector\|pgvector")
has_faiss=$(py_grep "import faiss\|from faiss")
has_milvus=$(py_grep "from pymilvus\|import pymilvus")
printf "Vector Stores: ChromaDB[%s] Pinecone[%s] Weaviate[%s] Qdrant[%s] pgvector[%s] FAISS[%s] Milvus[%s]\n" \
  "$([[ -n "$has_chromadb" ]] && echo Y || echo N)" \
  "$([[ -n "$has_pinecone" ]] && echo Y || echo N)" \
  "$([[ -n "$has_weaviate" ]] && echo Y || echo N)" \
  "$([[ -n "$has_qdrant" ]] && echo Y || echo N)" \
  "$([[ -n "$has_pgvector" ]] && echo Y || echo N)" \
  "$([[ -n "$has_faiss" ]] && echo Y || echo N)" \
  "$([[ -n "$has_milvus" ]] && echo Y || echo N)"

# Transformers & agent frameworks
has_transformers=$(py_grep "from transformers\|import transformers")
has_tiktoken=$(py_grep "import tiktoken\|from tiktoken")
has_dspy=$(py_grep "import dspy\|from dspy")
has_autogen=$(py_grep "import autogen\|from autogen")
printf "AI Misc: Transformers[%s] Tiktoken[%s] DSPy[%s] AutoGen[%s]\n" \
  "$([[ -n "$has_transformers" ]] && echo Y || echo N)" \
  "$([[ -n "$has_tiktoken" ]] && echo Y || echo N)" \
  "$([[ -n "$has_dspy" ]] && echo Y || echo N)" \
  "$([[ -n "$has_autogen" ]] && echo Y || echo N)"
echo "---"

# === Mobile Stack Detection ===
echo "=== Mobile Stack Detection ==="
# Expo
has_expo=""
if [ -f "app.json" ]; then
  has_expo=$(grep -l "expo" app.json 2>/dev/null || true)
fi
if [[ -z "$has_expo" ]]; then
  has_expo=$(find . -maxdepth 2 \( -name "app.config.js" -o -name "app.config.ts" \) -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)
fi
if [[ -z "$has_expo" ]] && [ "$HAS_JQ" = true ] && [ -f "package.json" ]; then
  jq -e '.dependencies["expo"] // .devDependencies["expo"]' package.json >/dev/null 2>&1 && has_expo="Y"
fi
# React Native
has_react_native=$(pkg_has "react-native")
has_expo_router=$(pkg_has "expo-router")
has_react_navigation=$(pkg_has "@react-navigation/native")
# Native platforms
has_swift=$(find . -maxdepth 5 -name "*.swift" -not -path "*/Pods/*" -not -path "*/.build/*" 2>/dev/null | head -1 || true)
has_kotlin=$(find . -maxdepth 5 -name "*.kt" -not -path "*/build/*" 2>/dev/null | head -1 || true)
has_dart=$(find . -maxdepth 5 -name "*.dart" -not -path "*/.dart_tool/*" 2>/dev/null | head -1 || true)
has_flutter=$(find . -maxdepth 2 -name "pubspec.yaml" 2>/dev/null | head -1 || true)
has_info_plist=$(find . -maxdepth 4 -name "Info.plist" -not -path "*/Pods/*" 2>/dev/null | head -1 || true)
has_android_manifest=$(find . -maxdepth 5 -name "AndroidManifest.xml" 2>/dev/null | head -1 || true)
printf "Mobile: Expo[%s] React Native[%s] Expo Router[%s] React Navigation[%s] Swift[%s] Kotlin[%s] Dart/Flutter[%s] Info.plist[%s] AndroidManifest[%s]\n" \
  "$([[ -n "$has_expo" ]] && echo Y || echo N)" \
  "$has_react_native" \
  "$has_expo_router" \
  "$has_react_navigation" \
  "$([[ -n "$has_swift" ]] && echo Y || echo N)" \
  "$([[ -n "$has_kotlin" ]] && echo Y || echo N)" \
  "$([[ -n "$has_dart" || -n "$has_flutter" ]] && echo Y || echo N)" \
  "$([[ -n "$has_info_plist" ]] && echo Y || echo N)" \
  "$([[ -n "$has_android_manifest" ]] && echo Y || echo N)"
echo "---"

# === Explicit Software Signals (Rust/Go) ===
has_cargo=$(find . -maxdepth 2 -name "Cargo.toml" 2>/dev/null | head -1 || true)
has_gomod=$(find . -maxdepth 2 -name "go.mod" 2>/dev/null | head -1 || true)

# === Domain Classification (Static) ===
echo "=== Domain Classification ==="
# Derived from detections above. A project can span multiple domains.
is_software=N; is_data_analytics=N; is_ml_ds=N; is_data_engineering=N
is_ai_llm=N; is_mobile=N; is_financial_analytics=N; is_content=N

# Software: frontend/backend frameworks + explicit Rust/Go
has_any "$has_nextjs" "$has_vue" "$has_angular" "$has_svelte" \
  "$has_nestjs" "$has_django" "$has_flask" "$has_fastapi" \
  "$has_cargo" "$has_gomod" && is_software=Y
[[ "$has_react" == "Y" || "$has_express" == "Y" ]] && is_software=Y

# Data Analytics: dbt + all BI/semantic model tools
has_any "$has_dbt" "$has_lookml" "$has_great_expectations" \
  "$has_omni" "$has_cube" "$has_lightdash" "$has_malloy" \
  "$has_evidence" "$has_holistics" "$has_dataform" "$has_superset" \
  "$has_soda" "$has_dbt_semantic" "$has_tableau" "$has_metabase" && is_data_analytics=Y

# ML/DS
has_any "$has_notebooks" "$has_mlproject" "$has_torch" \
  "$has_tensorflow" "$has_sklearn" && is_ml_ds=Y

# Data Engineering: orchestration + modern data stack
has_any "$has_airflow" "$has_airflow_dags" "$has_dagster" \
  "$has_prefect" "$has_spark" "$has_duckdb" "$has_polars" "$has_dlt" && is_data_engineering=Y

# AI/LLM: any SDK, vector store, agent framework, or transformer detection
has_any "$has_openai" "$has_anthropic" "$has_langchain" "$has_llama_index" \
  "$has_chromadb" "$has_pinecone" "$has_weaviate" "$has_qdrant" "$has_pgvector" \
  "$has_faiss" "$has_milvus" "$has_transformers" "$has_tiktoken" \
  "$has_dspy" "$has_autogen" && is_ai_llm=Y

# Mobile: Expo, React Native, Swift, Kotlin, Dart/Flutter, platform manifests
has_any "$has_expo" "$has_swift" "$has_kotlin" "$has_dart" "$has_flutter" \
  "$has_info_plist" "$has_android_manifest" && is_mobile=Y
[[ "$has_react_native" == "Y" || "$has_expo_router" == "Y" || "$has_react_navigation" == "Y" ]] && is_mobile=Y

# Financial Analytics and Content: heuristic only (no static signals — see below)

# === Heuristic Signals ===
# Runs AFTER static classification. Only attempts to classify domains still at N.
# Prints raw signal counts for debuggability.

if [[ "$is_data_analytics" == "N" ]]; then
  _sql_count=$(find . -name "*.sql" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/target/*" 2>/dev/null | wc -l | tr -d ' ')
  _yaml_model_count=$( (grep -r --include="*.yml" --include="*.yaml" "dimensions:\|measures:" . 2>/dev/null || true) | wc -l | tr -d ' ')
  if [[ "$_sql_count" -ge 5 && "$_yaml_model_count" -gt 2 ]]; then
    is_data_analytics=Y
    echo "Heuristic: data-analytics triggered (${_sql_count} SQL files, ${_yaml_model_count} YAML model refs)"
  fi
fi

if [[ "$is_ai_llm" == "N" ]]; then
  _prompt_model_cooccur=$( (grep -r --include="*.py" --exclude-dir=venv --exclude-dir=.venv \
    --exclude-dir=node_modules --exclude-dir=.git \
    "prompt\|template\|system_message" . 2>/dev/null || true) | \
    (grep -i "model\|embed\|completion\|chat" 2>/dev/null || true) | wc -l | tr -d ' ')
  _prompt_templates=$( (find . -type f \( -name "*prompt*" -o -name "*template*" \) \
    -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.claude/*" 2>/dev/null || true) | \
    (grep -i "prompt\|llm\|chat\|system" 2>/dev/null || true) | wc -l | tr -d ' ')
  if [[ "$_prompt_model_cooccur" -gt 3 || "$_prompt_templates" -gt 2 ]]; then
    is_ai_llm=Y
    echo "Heuristic: ai-llm triggered (${_prompt_model_cooccur} co-occurrence matches, ${_prompt_templates} prompt templates)"
  fi
fi

if [[ "$is_financial_analytics" == "N" ]]; then
  # Unambiguous financial terms only — avoids generic terms (return, yield, margin)
  _fin_hits=$( (grep -r -i --include="*.sql" --include="*.py" \
    "ebitda\|sharpe_ratio\|amortization\|general_ledger\|balance_sheet\|nav_calculation\|pnl_attribution\|income_statement\|journal_entry\|revenue_recognition\|fiscal_year" \
    . 2>/dev/null || true) | wc -l | tr -d ' ')
  if [[ "$_fin_hits" -gt 3 ]]; then
    is_financial_analytics=Y
    echo "Heuristic: financial-analytics triggered (${_fin_hits} matches with financial terms)"
  fi
fi

# Content: markdown >> code ratio (last resort, only if ALL other domains are N)
if [[ "$is_software" == "N" && "$is_data_analytics" == "N" && "$is_ml_ds" == "N" && \
      "$is_data_engineering" == "N" && "$is_ai_llm" == "N" && "$is_mobile" == "N" && \
      "$is_financial_analytics" == "N" ]]; then
  _md_count=$(find . -name "*.md" -not -path "*/.git/*" -not -path "*/node_modules/*" 2>/dev/null | wc -l | tr -d ' ')
  _code_count=$(find . \( -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "*.tsx" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.sql" \) \
    -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$_md_count" -gt 10 && "$_md_count" -gt "$_code_count" ]]; then
    is_content=Y
    echo "Heuristic: content triggered (${_md_count} markdown files > ${_code_count} code files)"
  fi
fi

# Fallback: if nothing detected, classify as software (most common).
# Unknown project types get software as default. Stage 1's AI model will refine.
if [[ "$is_software" == "N" && "$is_data_analytics" == "N" && "$is_ml_ds" == "N" && \
      "$is_data_engineering" == "N" && "$is_ai_llm" == "N" && "$is_mobile" == "N" && \
      "$is_financial_analytics" == "N" && "$is_content" == "N" ]]; then
  is_software=Y
fi

printf "Domains: software[%s] data-analytics[%s] ml-ds[%s] data-engineering[%s] ai-llm[%s] mobile[%s] financial-analytics[%s] content[%s]\n" \
  "$is_software" "$is_data_analytics" "$is_ml_ds" "$is_data_engineering" \
  "$is_ai_llm" "$is_mobile" "$is_financial_analytics" "$is_content"
echo "---"

# === Warehouse / Platform Context ===
echo "=== Warehouse / Platform Context ==="
# Two-pass: directory names first (fast), then grep fallback for config references
has_snowflake=""; has_bigquery=""; has_redshift=""; has_databricks=""
# Pass 1: single directory traversal
_wh_dirs=$(find . -maxdepth 4 -type d 2>/dev/null || true)
echo "$_wh_dirs" | grep -qi "snowflake" && has_snowflake=Y
echo "$_wh_dirs" | grep -qi "bigquery" && has_bigquery=Y
echo "$_wh_dirs" | grep -qi "redshift" && has_redshift=Y
echo "$_wh_dirs" | grep -qi "databricks" && has_databricks=Y
# Pass 2: config/code references (only if not found in pass 1)
if [[ -z "$has_snowflake" ]]; then
  has_snowflake=$(grep -r -i --include="*.yml" --include="*.yaml" --include="*.py" --include="*.sql" --include="*.json" \
    "snowflake" . 2>/dev/null | grep -v "node_modules\|\.git" | head -1 || true)
fi
if [[ -z "$has_bigquery" ]]; then
  has_bigquery=$(grep -r -i --include="*.yml" --include="*.yaml" --include="*.py" --include="*.sql" --include="*.json" \
    "bigquery\|google.cloud.bigquery" . 2>/dev/null | grep -v "node_modules\|\.git" | head -1 || true)
fi
if [[ -z "$has_redshift" ]]; then
  has_redshift=$(grep -r -i --include="*.yml" --include="*.yaml" --include="*.py" --include="*.sql" --include="*.json" \
    "redshift" . 2>/dev/null | grep -v "node_modules\|\.git" | head -1 || true)
fi
if [[ -z "$has_databricks" ]]; then
  has_databricks=$(grep -r -i --include="*.yml" --include="*.yaml" --include="*.py" --include="*.sql" --include="*.json" \
    "databricks" . 2>/dev/null | grep -v "node_modules\|\.git" | head -1 || true)
fi
printf "Warehouse: Snowflake[%s] BigQuery[%s] Redshift[%s] Databricks[%s]\n" \
  "$([[ -n "$has_snowflake" ]] && echo Y || echo N)" \
  "$([[ -n "$has_bigquery" ]] && echo Y || echo N)" \
  "$([[ -n "$has_redshift" ]] && echo Y || echo N)" \
  "$([[ -n "$has_databricks" ]] && echo Y || echo N)"
echo "---"

# === Language Distribution (Hard Counts) ===
echo "=== Language Distribution ==="
LANG_PATTERN='\.(py|js|ts|tsx|jsx|go|rs|java|rb|php|swift|kt|vue|svelte|sql|ipynb|dart|malloy|aml)$'
if [ "$IS_GIT_REPO" = true ]; then
  $FILE_LIST_CMD | grep -E "$LANG_PATTERN" | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -10 || echo "(no source files)"
else
  eval "$FILE_LIST_CMD" | grep -E "$LANG_PATTERN" | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -10 || echo "(no source files)"
fi
echo "---"

# === Git Signals ===
echo "=== Git Signals ==="
if [ "$IS_GIT_REPO" = true ]; then
  commit_count=$(git log --since="30 days ago" --oneline 2>/dev/null | wc -l | tr -d ' ')
  echo "Commits (30 days): $commit_count"

  echo "Hot files (top 5):"
  git log --pretty=format: --name-only -n 100 2>/dev/null | grep -v "^$" | sort | uniq -c | sort -rn | head -5 || echo "  (no history)"

  echo "Recent fixes/reverts:"
  git log --oneline -n 50 --grep="fix\|revert\|bug\|hotfix" -i 2>/dev/null | head -3 || echo "  (none)"
else
  echo "(not a git repo)"
fi
echo "---"

# === Test File Count ===
echo "=== Test Coverage Signal ==="
TEST_FILES=$(find . -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "test_*.py" -o -name "*_test.py" -o -name "*_test.go" \) \
  -not -path "*/node_modules/*" -not -path "*/.next/*" -not -path "*/.claude/*" 2>/dev/null | wc -l | tr -d ' ')
echo "Test files found: $TEST_FILES"
echo "---"

# === Project Metadata ===
echo "=== Project Metadata ==="
PROJECT_NAME=""
if [ "$HAS_JQ" = true ] && [ -f "package.json" ]; then
  PROJECT_NAME=$(jq -r '.name // empty' package.json 2>/dev/null || true)
fi
if [ -z "$PROJECT_NAME" ] && [ -f "pyproject.toml" ]; then
  PROJECT_NAME=$(grep -m1 "^name" pyproject.toml 2>/dev/null | sed 's/.*=\s*"//' | sed 's/".*//' || true)
fi
if [ -z "$PROJECT_NAME" ] && [ -f "dbt_project.yml" ]; then
  PROJECT_NAME=$(grep -m1 "^name:" dbt_project.yml 2>/dev/null | sed "s/name: *//" | sed "s/['\"]//g" || true)
fi
if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME=$(basename "$(pwd)")
fi
echo "Project: $PROJECT_NAME"
echo "Directory: $(pwd)"
echo "---"

echo "=== Ground Truth Complete ==="
