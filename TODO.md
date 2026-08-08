# TODO: Scrapeo manual + backend notificaciones/correcciones

## Pasos
- [x] 1. `app/app.vue`: eliminar polling automático de scrapeo (quitar checkInterval 5s y Facebook 15s)
- [x] 2. `app/app.vue`: cargar caché inicial sin auto-refresh continuo
- [x] 3. `app/app.vue`: agregar botón "Revisar" para disparar scrapeo manual
- [x] 4. `app/app.vue`: actualizar texto de estado (actualización manual)
- [x] 5. Verificar que notificaciones/correcciones usen backend (Redis + archivo) — ya implementado via sharedStore
- [x] 6. Commit "corriendo nuevo"
