---
name: interface-contract
description: Generate or update lightweight frontend-backend API contract documents for product requirements before implementation. Use when Codex needs to turn a PRD, Paper/Figma prototype, page design, or feature plan into `接口契约.md` / API contract content covering interface inventory, fields, enums, error codes, pagination, exports, Mock data, review statuses, owners, and companion updates to spec index or task split documents.
---

# Interface Contract

Create a reviewable frontend-backend contract between product requirements and development tasks. The contract is a living document for agile teams: draft first, review with owners, then mark confirmed items before coding.

## Core Positioning

Use this skill after the requirement is roughly clear and before implementation or task execution.

This skill should produce or update:

- `接口契约.md` or equivalent API contract document
- `规格索引.md` entries that summarize contract status and open questions
- `任务拆分.md` T0 review task when task splitting exists or is requested

Do not treat the contract as final Swagger/OpenAPI unless the user explicitly asks. It is the pre-development agreement that later informs Swagger, Apifox, YApi, OpenAPI, Mock data, frontend development, backend implementation, and testing.

## Maintaining an Existing Contract

For a small correction, follow [小范围变更与统一方案复用](../prd-architect/SKILL.md#小范围变更与统一方案复用) and update only the affected contract clauses and necessary references. Reuse the project's unified authorization or other shared scheme; specify the required business access, returned capabilities, and denial behavior without independently fixing identity tables, database fields, or methods. Source code may establish current behavior, but does not by itself authorize a new implementation decision. The full drafting workflow below is for new or substantially changed contracts, not every rule clarification.

## Default Workflow

### 1. Load Local Conventions

Before writing, inspect nearby documentation rules when available:

- `AGENTS.md`
- `README.md`
- existing `规格索引.md`
- existing `需求文档.md`
- existing `任务拆分.md`
- current design pages, descriptions, stable page IDs, and prototype assets

Follow the repository's existing file names and module directory structure. If no convention exists, prefer:

```text
{module}/{feature}/
  规格索引.md
  需求文档.md
  接口契约.md
  任务拆分.md
  原型设计/
```

For the current requirements workbench, page descriptions and artwork share the design model. Read them through `workbench design pull`; reference the current stable page ID in page/interface mappings. Do not create a second page-specification directory or edit migrated `页面设计/*.md` documents; those are read-only version history. Planned pages may have descriptions before artwork.

### 2. Gather Inputs

Use the best available sources:

- PRD or requirement notes for business rules and acceptance criteria
- Paper/Figma/prototype pages for visible UI needs
- Existing frontend code for current API usage and page entry points
- Existing backend code for controllers, services, DTOs, enums, error handling, and export paths
- Existing API docs when provided

Prefer `rg` / `rg --files` to locate code and docs. If code is unavailable, explicitly mark interface paths as candidates instead of inventing final answers.

### 3. Draft the Contract

Use `references/interface-contract-template.md` when creating a new contract or heavily restructuring one.

Required sections:

1. Document description and status
2. Contract principles
3. Review roles and status vocabulary
4. Page/interface inventory
5. Request/response field contracts
6. Enum contracts
7. Amount, time, and unit contracts when relevant
8. Error codes and user-facing messages
9. Pagination, query, sorting, and export contracts
10. Mock examples for success and key failures
11. Frontend/backend review checklist
12. Change log when the contract has been reviewed or revised

### 4. Use Lightweight Review By Default

Unless the user gives a larger team structure, default to:

- frontend owner: 1 person
- backend owner: 1 person

Add columns to key review tables:

```text
负责人 / 状态 / 评审结论 / 确认日期
```

Use precise statuses:

| Status | Meaning |
|--------|---------|
| 建议方案 | Proposed by product/Codex; review may adjust it |
| 复用确认 | Existing interface likely reusable; filters/fields/permissions need confirmation |
| 需扩展 | Existing interface can carry it but needs fields, validation, or return changes |
| 待接口归属确认 | Need backend decision on reuse vs new interface |
| 待字段命名确认 | Business meaning is clear; field names/enums/units need final decision |
| 待开放范围确认 | Edit/export/batch/open scope needs product/backend confirmation |
| 待确认 | Known review item not yet classified more specifically |
| 已确认 | Frontend and backend agreed; development can follow it |

### 5. Keep Drafts Honest

When uncertain, write “候选接口”, “建议字段”, or “待确认”, not fake certainty.

Do:

- propose names and shapes when helpful
- mark who needs to confirm
- distinguish product decisions from technical implementation decisions
- keep error messages display-ready when possible
- specify money units, time formats, IDs, enum values, empty values, and backward compatibility

Do not:

- hide missing backend decisions inside generic “待确认”
- let frontend infer business type from Chinese labels
- mix page explanation into the Paper/Figma canvas
- make unrelated technical design or database schema decisions unless requested

### 6. Update Companion Documents

When a `规格索引.md` exists, add or update:

- contract document link
- current contract status
- review mode and owners
- major confirmed specs
- open contract questions
- Paper/prototype source if relevant

When a `任务拆分.md` exists, ensure there is a pre-development task similar to:

```text
T0 接口契约评审与 Mock 确认
```

Its completion criteria should require owners to clear P0 contract blockers and fill review conclusions/dates.

## Output Quality Checklist

Before finishing, confirm:

- Page/interface inventory covers every visible page state or workflow touched by the requirement
- Each proposed field has type, unit, requiredness, default/empty behavior, and frontend display usage when relevant
- Enums are machine-readable and not based on UI labels
- Error codes include backend meaning and frontend display message
- Pagination, export, and Mock data are included when lists or reports exist
- Contract statuses are specific enough for a 2-person frontend/backend review
- Companion docs link to the contract and state that it is draft/confirmed as appropriate
- Existing screenshots are treated as input references; final page prototypes are linked to Paper/Figma when available
