# Model Selection Component Design

Date: 2026-04-17
Status: Approved for planning
Scope: Web app model selection UX for thread-level overrides and global default strategy

## Summary

Design a reusable model selection system that serves two distinct product surfaces:

1. A lightweight thread-level picker for quickly switching the active model for the current thread.
2. A richer settings-panel editor for configuring the default channel, default model, and fallback model chain used by new threads.

The system should reuse shared selection logic and data shaping, while keeping each UI surface focused on its own job. Thread-level changes must apply only to the current thread and must not mutate the global default strategy.

## Goals

- Reuse one model selection capability across thread UI and settings UI.
- Keep thread switching fast and low-friction.
- Support full default strategy configuration in settings:
  - default channel
  - default model
  - ordered fallback model chain
- Make inheritance and override behavior explicit.
- Reuse existing backend model normalization and fallback resolution behavior where possible.

## Non-Goals

- Thread-level fallback chain editing.
- Intelligent model recommendation based on task type.
- Price- or latency-based ranking.
- Automatic provider switching beyond the existing backend fallback and resolution logic.
- Cross-provider capability comparison UI in the first version.

## Product Decisions

### Surface split

The experience is one shared capability with two presentation levels:

- Thread surface: lightweight, immediate, current-thread-only override.
- Settings surface: complete default strategy editor for future threads.

### Override semantics

Thread-level changes override the default strategy only for the current thread.

- They do not modify global defaults.
- A thread can return to inherited behavior by clearing its override.

### Default strategy depth

The settings surface must support:

- default channel
- default model
- ordered fallback chain

### Thread list organization

The thread picker should list models grouped by provider or channel first, then models within each group.

## User Experience

## Thread Model Picker

Purpose: quickly change the model used by the current thread.

Behavior:

- Shows the currently effective model.
- Opens a grouped list of enabled models by channel.
- Applies selection immediately.
- Shows lightweight override status when the thread differs from global defaults.
- Provides a "restore default strategy" action that removes the thread override.

This surface should not expose fallback editing or verbose explanation copy.

## Default Model Strategy Panel

Purpose: configure the default strategy used by new threads.

Behavior:

- Lets the user choose a default channel.
- Lets the user choose the default model inside that channel.
- Lets the user build and order a fallback chain.
- Explains that fallback order is the order in which retries are attempted.
- Supports resetting back to inherited or system defaults if applicable.

This surface is the canonical place for durable model strategy configuration.

## Information Architecture

Two concepts must remain distinct in both code and UI:

1. Effective model selection
2. Default model strategy

### Default model strategy

Stored globally as:

- `defaultChannelId`
- `defaultModelId`
- `fallbackModelIds[]`

### Thread override

Stored on a thread as:

- `channelId`
- `modelRef`
- optional metadata indicating that the value is a thread override

### Effective selection rule

When determining the model for a thread:

1. Use thread override if present.
2. Otherwise use the global default strategy.
3. If the global default is missing or invalid, fall back to the channel default.
4. If needed, rely on backend fallback candidate resolution for final recovery.

The UI should always reflect the actual effective value, not just the nearest stored preference.

## Recommended Component Architecture

Use shared core logic with two outer components.

### 1. `useModelSelectionOptions`

Shared hook or state adapter responsible for:

- loading enabled channels and models
- shaping grouped option data
- deriving the current effective selection
- exposing valid fallback candidates
- annotating unavailable, inherited, and override states
- normalizing selections before submission

This layer should remain presentation-agnostic.

### 2. `ModelOptionList`

Shared presentational component responsible for:

- grouped rendering by channel
- selected state rendering
- optional status badges such as current, default, fallback
- optional empty or unavailable states

This component should not own thread or settings logic.

### 3. `ThreadModelPicker`

Thread-specific container responsible for:

- loading current thread state
- rendering the lightweight picker trigger
- writing thread overrides
- clearing thread override to restore inherited defaults
- presenting current effective model and override status

### 4. `DefaultModelStrategyPanel`

Settings-specific container responsible for:

- editing global default channel
- editing global default model
- editing ordered fallback chain
- inline validation and explanatory copy
- resetting default strategy values

## Interaction Details

### Thread picker interactions

- Trigger label shows current effective model name.
- Model list is grouped by channel.
- Selection is immediate.
- If the thread is using an override, show lightweight state such as "Overriding default".
- Include a restore action that removes only the thread override.

### Settings panel interactions

- Changing the default channel refreshes the available default model list.
- If the selected default model is not valid for the new channel, automatically choose the first valid model in that channel.
- Fallback entries must be unique.
- Fallback entries must not duplicate the selected default model.
- Fallback order is explicit and user-visible.
- Invalid or unavailable fallback entries should remain visible with an error state until fixed.

## Data Flow

### Frontend responsibilities

- Present grouped choices.
- Distinguish inherited state from overridden state.
- Submit user selections.
- Validate obvious client-side issues:
  - empty values
  - duplicate fallback entries
  - invalid fallback ordering interactions
- Render invalid or unavailable states clearly.

### Backend responsibilities

Existing backend logic should remain the source of truth for:

- provider normalization
- `modelRef` parsing
- adapter provider resolution
- default model recovery
- candidate fallback resolution

The frontend should reuse backend semantics instead of reimplementing provider parsing rules.

Relevant existing logic already exists in:

- `apps/sidecar/src/services/channel/model-selection.ts`

## Edge Cases

The design should explicitly handle the following:

### Thread override becomes invalid

If a thread override points to a disabled or removed model:

- the thread UI should show that the current override is unavailable
- the user should be prompted to choose another model or restore defaults
- the system must avoid silently pretending the override is still healthy

### Default model becomes invalid

If the configured default model is removed but the channel still exists:

- the settings UI should recover to the first valid model in that channel
- the UI should show a lightweight notice that recovery happened

### Invalid fallback entries

If a fallback model is no longer available:

- keep the entry visible
- mark it invalid
- require explicit user repair rather than silently dropping it

### Channel switch behavior

When the user changes the default channel:

- do not automatically migrate old fallback entries across channels
- re-evaluate the default model for the new channel
- make any invalid carry-over visible

### New thread inheritance

New threads inherit the current global default strategy, not another thread's override.

## Copy Recommendations

Suggested labels:

- Settings section title: `Default model strategy`
- Thread section title or tooltip: `Current thread model`
- Thread override badge: `Overriding default`
- Thread restore action: `Restore default strategy`
- Fallback help text: `If the default model is unavailable, these models are tried in order.`

## Testing Strategy

The implementation plan should cover at least the following tests.

### Thread behavior

- Thread without override uses the global default strategy.
- Selecting a thread model updates only that thread.
- Clearing thread override returns the thread to inherited defaults.
- Thread UI displays override state correctly.

### Settings behavior

- Changing default channel refreshes default model options.
- Invalid default model is recovered when the channel changes.
- Fallback chain rejects duplicates.
- Fallback chain rejects the current default model as a fallback entry.
- Fallback order is preserved through save and reload.

### Resilience behavior

- Disabled or removed models render as unavailable when previously selected.
- Effective selection shown in UI matches the values ultimately used by the sidecar.
- Backend fallback candidate behavior remains compatible with frontend assumptions.

## Implementation Direction

Preferred implementation approach:

- extract shared data shaping and option logic from the existing picker
- keep thread switching lightweight
- build settings editing as a dedicated strategy panel
- integrate with the existing sidecar model resolution utilities instead of duplicating them

This keeps the first version focused on correctness, reuse, and clear inheritance semantics.

## Open Questions Resolved

The following decisions were made during brainstorming and should not be reopened during implementation without a new product change:

- The system is one reusable capability with two UI surfaces.
- Thread changes apply only to the current thread.
- Settings must support channel, model, and fallback chain configuration.
- Thread list organization is grouped by provider or channel.

## Approval

This design was reviewed in brainstorming and approved to move into implementation planning.
