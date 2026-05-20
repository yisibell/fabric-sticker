<template>
  <div>
    <GoodsStickerV7
      ref="stickerRef"
      :width="400"
      :height="554"
      :bgImg="goodsImg"
      :sticker-img="stickerImg"
      :stickerArea="stickerArea"
    />
    <button @click="handleSave">保存图片</button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import GoodsStickerV7 from '@/components/GoodsSticker.vue';
import goodsImg from '@/assets/images/goods.png';
import stickerImg from '@/assets/images/demo.jpg';
import stickerImg2 from '@/assets/images/demo-2.jpeg';

const stickerRef = ref<InstanceType<typeof GoodsStickerV7> | null>(null);

const stickerArea = {
  left: 130,
  top: 180,
  width: 150,
  height: 150,
};

onMounted(() => {
  setTimeout(() => {
    stickerRef.value?.setStickerImage(stickerImg2);
  }, 1000)
});

const handleSave = async () => {
  if (!stickerRef.value) return;

  const base64Data = await stickerRef.value.getCombinedImage();
  if (base64Data) {
    console.log('成功获取合成图:', base64Data);
  }
};
</script>
