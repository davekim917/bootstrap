---
name: data-science
description: >
  Data science and machine learning practice patterns for notebooks, model development,
  experimentation, feature engineering, MLOps, and business analytics. Covers Jupyter, Python,
  pandas, scikit-learn, PyTorch, TensorFlow, MLflow, Weights & Biases, feature stores, model
  serving, A/B testing, statistical significance, causal inference, forecasting, and advanced
  analytics. Use when reviewing or building ML models, notebooks, experiments, ML infrastructure,
  A/B tests, or statistical analyses. Do not use for production data pipelines (use
  data-engineering), dbt/SQL models (use analytics-engineering), or business dashboards
  (use analytics).
---

# Data Science Practice

Domain-specific patterns for data science, ML, MLOps, and business analytics.

## Scope

- Jupyter notebooks and Python scripts
- Model development and training
- Feature engineering and feature stores
- Experiment tracking and reproducibility
- Model evaluation and validation
- ML deployment and serving (MLOps)
- A/B testing and statistical significance
- Causal inference and uplift modeling
- Time series forecasting
- Business analytics and advanced analytics

## Code Review Checklist

### Notebooks
- [ ] Clear narrative (problem → data → analysis → results → conclusions)
- [ ] Markdown cells explain reasoning, not just what code does
- [ ] Cells execute in order (restart kernel and run all works)
- [ ] No hardcoded absolute paths (use relative paths or config)
- [ ] Outputs cleared before commit (or meaningful outputs intentionally kept)
- [ ] No sensitive data in outputs
- [ ] Random seeds set for reproducibility
- [ ] Dependencies documented (requirements.txt or conda env)

### Data Processing
- [ ] Data loading is reproducible (versioned data, not local copies)
- [ ] Missing values handled explicitly (document expected vs unexpected)
- [ ] Outliers addressed or documented with rationale
- [ ] Feature transformations documented and versioned
- [ ] No data leakage (train/test split BEFORE any preprocessing)
- [ ] Data types appropriate (categories, not objects)
- [ ] Memory usage considered for large datasets

### Model Development
- [ ] Train/validation/test split appropriate for problem type
- [ ] Cross-validation used for model selection
- [ ] Hyperparameters documented and tracked
- [ ] Model versioned alongside data version
- [ ] Metrics appropriate for problem type and business context
- [ ] Baseline model established before complex models
- [ ] Overfitting checked (train vs validation performance gap)
- [ ] Prediction intervals or confidence estimates where relevant

### Experiment Tracking
- [ ] All experiments logged (MLflow, W&B, etc.) — no orphaned runs
- [ ] Parameters, metrics, and artifacts saved
- [ ] Git hash logged with every run
- [ ] Data version logged with every run
- [ ] Results reproducible from logged parameters

## Architecture Patterns

### Project Structure
```
project/
  notebooks/
    01_exploration.ipynb
    02_feature_engineering.ipynb
    03_modeling.ipynb
    04_evaluation.ipynb
  src/
    data/
      load.py           # Versioned data access
      preprocess.py
    features/
      build_features.py
      feature_store.py  # Feature registration
    models/
      train.py
      predict.py
      evaluate.py
    utils/
      metrics.py
      visualization.py
  configs/
    model_config.yaml
    feature_config.yaml
  tests/
    test_preprocessing.py
    test_features.py
    test_model_outputs.py
  models/               # Versioned model artifacts
  data/
    raw/                # Immutable original data
    processed/          # Cleaned, validated
    features/           # Computed feature sets
```

### No Data Leakage Pattern
```python
# Split FIRST — before anything that uses data statistics
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)

# Fit preprocessing on TRAIN only — transform both
from sklearn.pipeline import Pipeline
pipeline = Pipeline([
    ("scaler", StandardScaler()),
    ("model", RandomForestClassifier(n_estimators=100, random_state=42))
])
pipeline.fit(X_train, y_train)       # Fit on train
y_pred = pipeline.predict(X_test)    # Transform uses train stats
```

## Experiment Tracking

### MLflow Pattern
```python
import mlflow

mlflow.set_experiment("order_churn_prediction")

with mlflow.start_run(run_name=f"rf_v{VERSION}"):
    mlflow.set_tag("data_version", DATA_HASH)
    mlflow.set_tag("git_hash", get_git_hash())

    mlflow.log_params({
        "model_type": "random_forest",
        "n_estimators": 100,
        "max_depth": 10,
        "feature_set": "v3",
    })

    model = train_model(X_train, y_train)
    metrics = evaluate(model, X_test, y_test)

    mlflow.log_metrics(metrics)
    mlflow.log_artifact("confusion_matrix.png")
    mlflow.sklearn.log_model(model, "model", registered_model_name="order_churn")
```

### Weights & Biases Pattern
```python
import wandb

run = wandb.init(project="churn-prediction", config={
    "model": "xgboost",
    "learning_rate": 0.01,
    "n_estimators": 500,
    "feature_set": "v3",
})

# Auto-logs during training with callbacks
model = xgb.train(params, dtrain, evals=[(dtest, "eval")],
                  callbacks=[wandb.xgboost.WandbCallback()])

wandb.log({"precision": precision, "recall": recall, "auc": auc})
wandb.finish()
```

## MLOps Patterns

### Model Lifecycle Stages
```
Development → Staging → Production
   (MLflow experiment runs) → (Model Registry: Staging) → (Model Registry: Production)
```

### Model Registry Pattern
```python
from mlflow.tracking import MlflowClient
client = MlflowClient()

# Promote to staging after passing eval thresholds
if metrics["auc"] >= STAGING_AUC_THRESHOLD:
    client.transition_model_version_stage(
        name="order_churn",
        version=new_version,
        stage="Staging"
    )

# Promote to production after A/B test or shadow mode validation
if shadow_mode_passed:
    client.transition_model_version_stage(
        name="order_churn",
        version=staging_version,
        stage="Production"
    )
```

### Model Serving Patterns
| Serving pattern | When to use | Stack |
|---|---|---|
| Real-time REST API | <100ms latency required, per-request | FastAPI + mlflow.pyfunc / BentoML |
| Batch scoring | Offline predictions, daily/hourly | Spark MLlib, scikit-learn + job scheduler |
| Feature store + pre-computed | High volume, deterministic features | Feast, Tecton, Vertex AI Feature Store |
| Streaming inference | Continuous, event-triggered | Flink + ONNX or TorchScript |

### CI/CD for Models
```yaml
# .github/workflows/model-ci.yml
on: [push]
jobs:
  train-and-evaluate:
    steps:
      - run: python train.py --config configs/model_config.yaml
      - run: python evaluate.py --threshold 0.80  # Fail build if AUC < 0.80
      - run: mlflow models build-docker -m models:/order_churn/Staging
      - run: pytest tests/ -v  # Data tests, feature tests, output schema tests
```

## Feature Engineering

### Feature Store Pattern
```python
# Register features once — reuse across training and serving
from feast import FeatureStore, Feature, FeatureView, FileSource, ValueType

customer_features = FeatureView(
    name="customer_stats",
    entities=["customer_id"],
    features=[
        Feature(name="order_count_30d", dtype=ValueType.INT64),
        Feature(name="avg_order_value", dtype=ValueType.DOUBLE),
        Feature(name="days_since_last_order", dtype=ValueType.INT64),
    ],
    online=True,  # Serve at inference time
    batch_source=FileSource(path="data/features/customer_stats.parquet"),
)

# Training: retrieve historical features (point-in-time correct)
training_df = store.get_historical_features(entity_df, feature_refs).to_df()

# Inference: retrieve online features
online_features = store.get_online_features(
    features=["customer_stats:order_count_30d"],
    entity_rows=[{"customer_id": cid}]
).to_dict()
```

**Feature Engineering Checklist:**
- [ ] Point-in-time correct joins (no future data leakage in historical features)
- [ ] Feature drift monitoring in production (distribution shift detection)
- [ ] Features computable at inference time (no batch-only features in real-time models)
- [ ] Feature transformations versioned alongside model versions

## A/B Testing & Statistical Methods

### A/B Test Setup
```python
from scipy import stats

def ab_test_significance(
    control_conversions: int, control_n: int,
    treatment_conversions: int, treatment_n: int,
    alpha: float = 0.05
) -> dict:
    control_rate = control_conversions / control_n
    treatment_rate = treatment_conversions / treatment_n

    # Two-proportion z-test
    count = np.array([treatment_conversions, control_conversions])
    nobs = np.array([treatment_n, control_n])
    stat, p_value = proportions_ztest(count, nobs)

    # Minimum detectable effect validation
    # Never run a test that's underpowered
    power = calculate_power(control_rate, treatment_rate, control_n, treatment_n)

    return {
        "control_rate": control_rate,
        "treatment_rate": treatment_rate,
        "relative_lift": (treatment_rate - control_rate) / control_rate,
        "p_value": p_value,
        "significant": p_value < alpha,
        "statistical_power": power,
        "valid": power >= 0.80,  # Underpowered tests are unreliable
    }
```

**A/B Test Checklist:**
- [ ] Sample size calculated BEFORE running test (power analysis)
- [ ] Randomization unit appropriate (user, session, device)
- [ ] Test ran for full business cycles (at least 1-2 weeks to capture weekly patterns)
- [ ] No peeking (p-value checked before test completes)
- [ ] Guardrail metrics monitored alongside primary metric
- [ ] SUTVA holds (treatment and control don't interact)
- [ ] Multiple comparisons correction if testing multiple variants

### Causal Inference Decision Table
| Question | Method |
|---|---|
| Did feature X cause outcome Y? (observational data) | DiD, Propensity Score Matching, IV |
| What would have happened without treatment? | Synthetic Control |
| Heterogeneous treatment effects (who benefits most?) | Uplift modeling, Causal Forest |
| Long-term vs short-term effects | Holdout groups, Switchback tests |

## Model Evaluation

### Classification Metrics
| Metric | When to Use |
|---|---|
| Accuracy | Balanced classes — rarely meaningful alone |
| Precision | Cost of false positives is high (spam filter) |
| Recall | Cost of false negatives is high (fraud, disease) |
| F1 | Balance precision/recall for imbalanced classes |
| AUC-ROC | Model discrimination across thresholds |
| PR-AUC | Imbalanced classes where precision at low recall matters |

### Regression Metrics
| Metric | When to Use |
|---|---|
| MAE | Interpretable, robust to outliers |
| RMSE | Penalize large errors more |
| MAPE | Percentage-based comparison (beware zeros) |
| R² | Variance explained (misleading for non-linear) |

### Business Metric Alignment
Always tie model metrics to business outcomes:
- "AUC 0.85" → "We identify 78% of churners while contacting only 15% of customers"
- "RMSE $12" → "Demand forecasts are within ±12 units on average, reducing stockouts by 23%"

## Forecasting

### Time Series Patterns
```python
# Prophet — fast baseline for business time series
from prophet import Prophet

m = Prophet(
    seasonality_mode="multiplicative",  # For data with growing seasonality
    weekly_seasonality=True,
    yearly_seasonality=True,
    changepoint_prior_scale=0.05,       # Regularize trend changes
)
m.add_country_holidays(country_name="US")
m.fit(df[["ds", "y"]])

future = m.make_future_dataframe(periods=90)
forecast = m.predict(future)
```

**Forecasting Checklist:**
- [ ] Evaluate on held-out test period (not just CV)
- [ ] Forecast horizon matches business decision cycle
- [ ] Prediction intervals reported (not just point forecasts)
- [ ] Seasonal patterns validated against business knowledge
- [ ] Model compared to naive baselines (last value, moving average, seasonal naive)

## Common Anti-Patterns

| Anti-pattern | Fix |
|---|---|
| Data leakage (fitting on test data) | Split before any preprocessing; use Pipelines |
| No random seed | Set `random_state` everywhere — reproducibility is not optional |
| Overfitting (no validation set) | Always hold out a validation set during model selection |
| Training on all data without holdout | Reserve test set before development starts — don't touch it |
| Ignoring class imbalance | Use stratified splits, class weights, or resampling |
| No baseline comparison | Always implement naive baseline before complex model |
| A/B test peeking | Pre-commit to sample size; don't check until test completes |
| Notebooks that don't run top-to-bottom | CI gate: restart kernel and run all before merge |
| Magic numbers and hardcoded paths | Config files for hyperparams; relative paths |
| No experiment tracking | If it's not logged, it didn't happen |
| Model in production with no monitoring | Set up drift detection and performance monitoring on day one |

## Technology Notes

### pandas
- `.loc` and `.iloc` explicitly (avoid chained indexing)
- Chain operations with `.pipe()` for readability
- Use `pd.NA` over `None` for missing values
- `df.info(memory_usage='deep')` before loading large datasets

### scikit-learn
- Use `Pipeline` for all preprocessing + model — prevents leakage
- `GridSearchCV`/`RandomizedSearchCV` with `cv` parameter
- `joblib.dump` for model serialization

### PyTorch
- `DataLoader` with `num_workers > 0` for parallel loading
- Move model and data to same device explicitly
- Checkpoint every N epochs; don't rely on final epoch only
- `torch.manual_seed` + `torch.cuda.manual_seed_all` for reproducibility
