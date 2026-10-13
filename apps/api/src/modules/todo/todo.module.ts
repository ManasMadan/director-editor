import { Module } from "@nestjs/common";
import { TodoRepository } from "./todo.repository";
import { TodoService } from "./todo.service";

@Module({ providers: [TodoRepository, TodoService], exports: [TodoService] })
export class TodoModule {}
