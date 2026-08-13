package com.example;

public class Service {
    public int total(Order order) {
        return order.getId() + 100;
    }

    public void ping() {
        // 空方法
    }
}
