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
      // 清空数组，确保每次都是全新的数据
      this.filesToDelete = [];

      if (!this.isListing) {
        // 非列表模式：删除当前路径的文件
        // 从路由路径提取文件名，确保 name 和 url 对应同一个文件
        const pathParts = this.$route.path.split("/").filter((p) => p);
        const fileName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : "";
        const fileUrl = this.$route.path;
        
        // 保存文件信息：name 用于显示，url 用于删除
        // 这两个值必须对应同一个文件，且之后不再修改
        this.filesToDelete = [{ 
          name: fileName || fileUrl, 
          url: fileUrl,
          path: fileUrl, // 保存 path 用于后续操作（如预选）
        }];
        return;
      }

      // 列表模式：保存所有选中文件的信息
      if (this.selectedCount === 0 || !this.req?.items) {
        return;
      }

      // 立即保存文件信息（路径和名称），而不是保存索引
      // 这样即使 req.items 在弹窗显示期间更新，也能确保删除正确的文件
      // 关键：name、url、path 必须来自同一个 item 对象，确保数据一致性
      for (const index of this.selected) {
        const item = this.req.items[index];
        if (item && item.name && item.url) {
          // 验证：确保 name 和 url 来自同一个 item
          // 这些数据将用于显示（name）和删除（url），必须完全一致
          this.filesToDelete.push({
            name: item.name,  // 显示在弹窗中的文件名
            url: item.url,    // 用于删除的 URL（传递给 api.remove）
            path: item.path,  // 用于后续操作（如预选）
          });
        } else {
          console.warn("[Delete] WARNING: Invalid item at index", index, ":", item);
        }
      }
      
      // 验证：确保保存的文件数量与选中数量一致
      if (this.filesToDelete.length !== this.selectedCount) {
        console.warn(
          "[Delete] WARNING: filesToDelete length", 
          this.filesToDelete.length, 
          "does not match selectedCount", 
          this.selectedCount
        );
      }
    },
    submit: async function () {
      buttons.loading("delete");

      try {
        // 严格检查：确保 filesToDelete 不为空
        // 这是显示在弹窗中的数据，必须和删除时使用的数据完全一致
        if (this.filesToDelete.length === 0) {
          console.error("[Delete] ERROR: filesToDelete is empty, cannot proceed with deletion");
          buttons.done("delete");
          this.$showError(new Error("无法删除：未找到要删除的文件"));
          return;
        }

        // 验证：确保显示的文件名和要删除的 URL 对应的是同一个文件
        // filesToDelete 数组在 mounted 时保存，之后不再修改，确保数据一致性
        if (!this.isListing) {
          // 非列表模式：删除单个文件
          // 使用保存的 URL，确保和显示的文件名一致
          const fileToDelete = this.filesToDelete[0];
          if (!fileToDelete || !fileToDelete.url) {
            console.error("[Delete] ERROR: Invalid fileToDelete data:", fileToDelete);
            buttons.done("delete");
            this.$showError(new Error("无法删除：文件数据无效"));
            return;
          }
          
          // 使用保存的 URL 删除，这是显示在弹窗中的文件的 URL
          await api.remove(fileToDelete.url);
          buttons.success("delete");

          this.currentPrompt?.confirm();
          this.closeHovers();
          return;
        }

        // 列表模式：删除多个文件
        this.closeHovers();

        // 使用保存的文件路径列表删除
        // 这些 URL 和显示在弹窗中的文件名（filesToDelete[].name）完全对应
        // 确保显示和删除使用的是同一个数据源（filesToDelete 数组）
        const promises = [];
        for (const file of this.filesToDelete) {
          if (!file || !file.url) {
            console.error("[Delete] ERROR: Invalid file data in filesToDelete:", file);
            continue;
          }
          // 使用保存的 URL，确保和显示的文件名一致
          promises.push(api.remove(file.url));
        }

        if (promises.length === 0) {
          buttons.done("delete");
          this.$showError(new Error("无法删除：没有有效的文件数据"));
          return;
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
