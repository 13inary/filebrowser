<template>
  <div class="card floating">
    <div class="card-content">
      <p v-if="!this.isListing || selectedCount === 1">
        {{ $t("prompts.deleteMessageSingle") }}
      </p>
      <p v-else>
        {{ $t("prompts.deleteMessageMultiple", { count: selectedCount }) }}
      </p>
      <!-- 突出显示要删除的文件名 -->
      <div v-if="filesToDelete.length > 0" class="delete-targets">
        <div v-if="filesToDelete.length === 1" class="delete-target-single">
          <strong class="delete-target-name">{{ filesToDelete[0].name }}</strong>
        </div>
        <div v-else class="delete-target-multiple">
          <div v-for="(file, index) in filesToDelete" :key="index" class="delete-target-item">
            <strong class="delete-target-name">{{ file.name }}</strong>
          </div>
        </div>
      </div>
    </div>
    <div class="card-action">
      <button
        @click="closeHovers"
        class="button button--flat button--grey"
        :aria-label="$t('buttons.cancel')"
        :title="$t('buttons.cancel')"
        tabindex="2"
      >
        {{ $t("buttons.cancel") }}
      </button>
      <button
        id="focus-prompt"
        @click="submit"
        class="button button--flat button--red"
        :aria-label="$t('buttons.delete')"
        :title="$t('buttons.delete')"
        tabindex="1"
      >
        {{ $t("buttons.delete") }}
      </button>
    </div>
  </div>
</template>

<script>
import { mapActions, mapState, mapWritableState } from "pinia";
import { files as api } from "@/api";
import buttons from "@/utils/buttons";
import { useFileStore } from "@/stores/file";
import { useLayoutStore } from "@/stores/layout";

export default {
  name: "delete",
  inject: ["$showError"],
  data() {
    return {
      // 在组件创建时立即保存要删除的文件信息（路径和名称），
      // 而不是依赖索引，防止列表更新导致删除错误文件
      filesToDelete: [],
    };
  },
  computed: {
    ...mapState(useFileStore, [
      "isListing",
      "selectedCount",
      "req",
      "selected",
    ]),
    ...mapState(useLayoutStore, ["currentPrompt"]),
    ...mapWritableState(useFileStore, ["reload", "preselect"]),
  },
  mounted() {
    // 在组件挂载时立即保存要删除的文件信息
    // 这样可以避免在弹窗显示期间，如果文件列表更新，导致索引指向错误文件
    this.saveFilesToDelete();
  },
  methods: {
    ...mapActions(useLayoutStore, ["closeHovers"]),
    saveFilesToDelete() {
      this.filesToDelete = [];

      if (!this.isListing) {
        // 非列表模式：删除当前路径的文件
        const pathParts = this.$route.path.split("/").filter((p) => p);
        const fileName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : "";
        this.filesToDelete = [{ name: fileName || this.$route.path, url: this.$route.path }];
        return;
      }

      // 列表模式：保存所有选中文件的信息
      if (this.selectedCount === 0 || !this.req?.items) {
        return;
      }

      // 立即保存文件信息（路径和名称），而不是保存索引
      // 这样即使 req.items 在弹窗显示期间更新，也能确保删除正确的文件
      for (const index of this.selected) {
        const item = this.req.items[index];
        if (item) {
          this.filesToDelete.push({
            name: item.name,
            url: item.url,
            path: item.path,
          });
        }
      }
    },
    submit: async function () {
      buttons.loading("delete");

      try {
        if (!this.isListing) {
          // 使用保存的路径，而不是 this.$route.path（虽然通常相同，但更安全）
          const urlToDelete = this.filesToDelete.length > 0 
            ? this.filesToDelete[0].url 
            : this.$route.path;
          await api.remove(urlToDelete);
          buttons.success("delete");

          this.currentPrompt?.confirm();
          this.closeHovers();
          return;
        }

        this.closeHovers();

        if (this.filesToDelete.length === 0) {
          return;
        }

        // 使用保存的文件路径列表，而不是通过索引访问 req.items
        // 这样可以确保即使文件列表在弹窗显示期间更新，也能删除正确的文件
        const promises = [];
        for (const file of this.filesToDelete) {
          promises.push(api.remove(file.url));
        }

        await Promise.all(promises);
        buttons.success("delete");

        // 计算附近项目用于预选（使用保存的文件信息）
        if (this.filesToDelete.length > 0 && this.req?.items) {
          const firstDeletedPath = this.filesToDelete[0].path;
          const firstDeletedIndex = this.req.items.findIndex(
            (item) => item.path === firstDeletedPath
          );
          const nearbyIndex = Math.max(0, firstDeletedIndex - 1);
          const nearbyItem = this.req.items[nearbyIndex];
          this.preselect = nearbyItem?.path;
        }

        this.reload = true;
      } catch (e) {
        buttons.done("delete");
        this.$showError(e);
        if (this.isListing) this.reload = true;
      }
    },
  },
};
</script>

<style scoped>
.delete-targets {
  margin-top: 1rem;
  padding: 0.75rem;
  background-color: rgba(244, 67, 54, 0.1);
  border-left: 3px solid #f44336;
  border-radius: 4px;
}

.delete-target-single {
  text-align: center;
}

.delete-target-multiple {
  max-height: 200px;
  overflow-y: auto;
}

.delete-target-item {
  margin: 0.5rem 0;
  padding: 0.5rem;
  background-color: rgba(255, 255, 255, 0.5);
  border-radius: 3px;
}

.delete-target-name {
  color: #d32f2f;
  font-size: 1.1em;
  word-break: break-all;
}
</style>
