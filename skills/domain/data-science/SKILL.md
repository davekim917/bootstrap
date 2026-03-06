---
name: data-science
description: Data science and machine learning practice patterns for notebooks, model development, experimentation, feature engineering, and MLOps. Covers Jupyter, Python, pandas, scikit-learn, PyTorch, TensorFlow, MLflow, model evaluation, and deployment. Use when reviewing or building ML models, notebooks, experiments, or ML infrastructure. Do not use for production data pipelines (use data-engineering), dbt/SQL models (use analytics-engineering), or business dashboards (use analytics).
---

# Data Science Practice

Domain-specific patterns and checklists for data science and ML work.

## Scope

- Jupyter notebooks and scripts
- Model development and training
- Feature engineering
- Experiment tracking
- Model evaluation and validation
- ML deployment and serving

## Code Review Checklist

### Notebooks
- [ ] Clear narrative flow (problem → data → analysis → results)
- [ ] Markdown cells explain reasoning
- [ ] Cells execute in order (restart and run all works)
- [ ] No hardcoded paths (use config or relative paths)
- [ ] Outputs cleared before commit (or meaningful outputs kept)
- [ ] No sensitive data in outputs
- [ ] Reproducible (random seeds set)
- [ ] Dependencies documented

### Data Processing
- [ ] Data loading is reproducible
- [ ] Missing values handled explicitly
- [ ] Outliers addressed or documented
- [ ] Feature transformations documented
- [ ] No data leakage (train/test split before preprocessing)
- [ ] Data types appropriate
- [ ] Memory usage considered for large datasets

### Model Development
- [ ] Train/validation/test split appropriate
- [ ] Cross-validation used for model selection
- [ ] Hyperparameters documented
- [ ] Model versioned (with data version)
- [ ] Metrics appropriate for problem type
- [ ] Baseline model established
- [ ] Overfitting checked (train vs validation gap)

### Experiment Tracking
- [ ] Experiments logged (MLflow, W&B, etc.)
- [ ] Parameters tracked
- [ ] Metrics tracked
- [ ] Artifacts saved (model, plots, data samples)
- [ ] Reproducibility info logged (git hash, data version)

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
      load.py
      preprocess.py
    features/
      build_features.py
    models/
      train.py
      predict.py
      evaluate.py
    visualization/
      plots.py
  configs/
    model_config.yaml
  tests/
    test_preprocessing.py
    test_features.py
  models/              # Saved models
  data/
    raw/               # Immutable original data
    processed/         # Cleaned data
    features/          # Feature sets
```

### Notebook Template
```python
# %% [markdown]
# # Title: Clear Problem Statement
#
# ## Objective
# What we're trying to achieve
#
# ## Data
# Source and description

# %% Setup
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split

RANDOM_STATE = 42
np.random.seed(RANDOM_STATE)

# %% Load Data
# ...

# %% Explore
# ...

# %% Preprocess
# ...

# %% Model
# ...

# %% Evaluate
# ...

# %% [markdown]
# ## Conclusions
# Key findings and next steps
```

### Train/Test Split Pattern
```python
# Split BEFORE any preprocessing that uses full data statistics
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)

# Fit preprocessing on train only
scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)
X_test_scaled = scaler.transform(X_test)  # transform only
```

### Experiment Tracking Pattern
```python
import mlflow

with mlflow.start_run(run_name="experiment_v1"):
    # Log parameters
    mlflow.log_param("model_type", "random_forest")
    mlflow.log_param("n_estimators", 100)

    # Train model
    model = train_model(X_train, y_train)

    # Log metrics
    predictions = model.predict(X_test)
    mlflow.log_metric("accuracy", accuracy_score(y_test, predictions))
    mlflow.log_metric("f1", f1_score(y_test, predictions))

    # Log model
    mlflow.sklearn.log_model(model, "model")

    # Log artifacts
    mlflow.log_artifact("confusion_matrix.png")
```

## Model Evaluation

### Classification Metrics
| Metric | When to Use |
|--------|-------------|
| Accuracy | Balanced classes |
| Precision | False positives are costly |
| Recall | False negatives are costly |
| F1 | Balance precision/recall |
| AUC-ROC | Compare across thresholds |

### Regression Metrics
| Metric | When to Use |
|--------|-------------|
| MAE | Interpretable, robust to outliers |
| RMSE | Penalize large errors |
| MAPE | Percentage-based comparison |
| R² | Variance explained |

## Common Anti-Patterns

- ❌ Data leakage (fitting on test data)
- ❌ No random seed (non-reproducible results)
- ❌ Overfitting (no validation set)
- ❌ Training on all data (no holdout for final evaluation)
- ❌ Ignoring class imbalance
- ❌ No baseline model for comparison
- ❌ Notebooks that don't run top-to-bottom
- ❌ Hardcoded paths and magic numbers
- ❌ No experiment tracking (can't reproduce results)

## Technology-Specific Notes

### pandas
- Use `.loc` and `.iloc` explicitly
- Chain operations with `.pipe()`
- Use `pd.NA` over `None` for missing
- Profile memory with `df.info(memory_usage='deep')`

### scikit-learn
- Use Pipelines for reproducibility
- Use GridSearchCV with cv parameter
- Prefer StandardScaler in pipelines
- Use `joblib` for model serialization

### PyTorch/TensorFlow
- Use DataLoaders for batching
- Move models to GPU explicitly
- Use mixed precision for large models
- Checkpoint during training
- Use TensorBoard for visualization

### MLflow
- Use experiments to organize runs
- Tag runs with meaningful metadata
- Register models in Model Registry
- Use model stages (Staging, Production)
