<script lang="ts">
  import { toasts, dismissToast } from "../lib/ui/toast";
</script>

<div class="toast-host">
  {#each $toasts as toast (toast.id)}
    <button class="toast toast-{toast.kind}" onclick={() => dismissToast(toast.id)} title="Dismiss">
      {toast.text}
    </button>
  {/each}
</div>

<style>
  .toast-host {
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    background: rgba(20, 20, 24, 0.94);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    padding: 8px 14px;
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .toast-warning {
    border-color: #e04040;
  }
</style>
