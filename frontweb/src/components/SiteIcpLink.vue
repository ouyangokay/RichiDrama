<template>
  <a
    v-if="siteConfig.icpNumber"
    class="site-icp-link"
    :href="siteConfig.icpUrl"
    target="_blank"
    rel="noopener noreferrer"
  >{{ siteConfig.icpNumber }}</a>
</template>

<script setup>
import { siteConfig } from '@/config/site'
</script>

<style scoped>
.site-icp-link {
  display: inline-block;
  max-width: 100%;
  color: inherit;
  font-size: 12px;
  line-height: 1.8;
  letter-spacing: normal;
  overflow-wrap: anywhere;
  text-decoration: none;
}
.site-icp-link:hover { text-decoration: underline; }
.site-icp-link:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
</style>
