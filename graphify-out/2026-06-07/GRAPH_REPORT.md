# Graph Report - .  (2026-06-07)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 89 nodes · 118 edges · 14 communities
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6a26ffaa`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Alibaba Cloud Configuration|Alibaba Cloud Configuration]]
- [[_COMMUNITY_TypeScript Compiler Settings|TypeScript Compiler Settings]]
- [[_COMMUNITY_AI Models and Providers|AI Models and Providers]]
- [[_COMMUNITY_Package Metadata|Package Metadata]]
- [[_COMMUNITY_Project Dependencies|Project Dependencies]]
- [[_COMMUNITY_Plan Model Management|Plan Model Management]]
- [[_COMMUNITY_Model Type Inference|Model Type Inference]]
- [[_COMMUNITY_Plan and Cloud Loading|Plan and Cloud Loading]]
- [[_COMMUNITY_Authentication Management|Authentication Management]]
- [[_COMMUNITY_Issue Tracking|Issue Tracking]]
- [[_COMMUNITY_Cloud Model Persistence|Cloud Model Persistence]]
- [[_COMMUNITY_Configuration and Login|Configuration and Login]]
- [[_COMMUNITY_PI Extensions and Images|PI Extensions and Images]]
- [[_COMMUNITY_Build and Scripts|Build and Scripts]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 13 edges
2. `pi-alibaba-models Extension` - 7 edges
3. `readJSON()` - 5 edges
4. `writeJSON()` - 5 edges
5. `inferPlanDef()` - 5 edges
6. `fetchPlanModels()` - 5 edges
7. `resolvePlanEndpoints()` - 5 edges
8. `migrateLegacyAuth()` - 5 edges
9. `loadConfig()` - 4 edges
10. `loadPlanDefs()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `Qwen 3.7 Plus` --conceptually_related_to--> `pi-alibaba-models Extension`  [INFERRED]
  CHANGELOG.md → README.md
- `Qwen 3.7 Max` --conceptually_related_to--> `pi-alibaba-models Extension`  [INFERRED]
  CHANGELOG.md → README.md
- `Qwen 3.6 Max` --conceptually_related_to--> `pi-alibaba-models Extension`  [INFERRED]
  CHANGELOG.md → README.md
- `Qwen 3.6 Plus` --conceptually_related_to--> `pi-alibaba-models Extension`  [INFERRED]
  CHANGELOG.md → README.md
- `DeepSeek V4 Pro` --conceptually_related_to--> `pi-alibaba-models Extension`  [INFERRED]
  CHANGELOG.md → README.md

## Import Cycles
- None detected.

## Communities (14 total, 0 thin omitted)

### Community 0 - "Alibaba Cloud Configuration"
Cohesion: 0.13
Nodes (11): AlibabaConfig, AUTH_PATH, CLOUD_CACHE_PATH, CloudCache, cloudDefs, CONFIG_PATH, HOME_DIR, PLAN_CACHE_PATH (+3 more)

### Community 1 - "TypeScript Compiler Settings"
Cohesion: 0.13
Nodes (14): compilerOptions, allowImportingTsExtensions, allowSyntheticDefaultImports, esModuleInterop, lib, module, moduleResolution, noEmit (+6 more)

### Community 2 - "AI Models and Providers"
Cohesion: 0.22
Nodes (9): DeepSeek V4 Pro, Qwen 3.6 Max, Qwen 3.6 Plus, Qwen 3.7 Max, Qwen 3.7 Plus, Alibaba Cloud Provider, Alibaba Plan Provider, pi-alibaba-models Extension (+1 more)

### Community 3 - "Package Metadata"
Cohesion: 0.22
Nodes (8): author, description, files, homepage, keywords, license, name, version

### Community 4 - "Project Dependencies"
Cohesion: 0.29
Nodes (7): devDependencies, @earendil-works/pi-coding-agent, @types/node, typescript, optional, peerDependencies, peerDependenciesMeta

### Community 5 - "Plan Model Management"
Cohesion: 0.50
Nodes (5): buildPlanModels(), fetchPlanModels(), fetchPlanModelsFromAPI(), modifyModels(), resolvePlanEndpoints()

### Community 6 - "Model Type Inference"
Cohesion: 0.40
Nodes (5): inferContextWindow(), inferPlanDef(), isReasoningModel(), isVisionModel(), prettyName()

### Community 7 - "Plan and Cloud Loading"
Cohesion: 0.67
Nodes (4): cacheAgeMin(), loadCloudDefs(), loadPlanDefs(), readJSON()

### Community 8 - "Authentication Management"
Cohesion: 0.50
Nodes (4): extractKey(), migrateLegacyAuth(), readAuth(), writeAuth()

### Community 9 - "Issue Tracking"
Cohesion: 0.50
Nodes (4): bugs, url, repository, type

### Community 10 - "Cloud Model Persistence"
Cohesion: 0.67
Nodes (3): fetchCloudModels(), saveConfig(), writeJSON()

### Community 11 - "Configuration and Login"
Cohesion: 0.67
Nodes (3): isPlanKey(), loadConfig(), login()

### Community 12 - "PI Extensions and Images"
Cohesion: 0.67
Nodes (3): pi, extensions, image

### Community 13 - "Build and Scripts"
Cohesion: 0.67
Nodes (3): scripts, build, prepublishOnly

## Knowledge Gaps
- **46 isolated node(s):** `HOME_DIR`, `CONFIG_PATH`, `AUTH_PATH`, `PLAN_CACHE_PATH`, `CLOUD_CACHE_PATH` (+41 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `Project Dependencies` to `Package Metadata`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Why does `scripts` connect `Build and Scripts` to `Package Metadata`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `pi-alibaba-models Extension` (e.g. with `DeepSeek V4 Pro` and `Qwen 3.6 Max`) actually correct?**
  _`pi-alibaba-models Extension` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `HOME_DIR`, `CONFIG_PATH`, `AUTH_PATH` to the rest of the system?**
  _46 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Alibaba Cloud Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Should `TypeScript Compiler Settings` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._